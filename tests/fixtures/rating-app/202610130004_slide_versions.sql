-- Published versions preserve content, publication dates and their own votes.
-- Additive data migration: no captions or votes are deleted. Existing content becomes V1.
begin;
lock table public.captions, public.caption_votes in access exclusive mode;
create table public.caption_versions (
 id uuid primary key default gen_random_uuid(),
 caption_id uuid not null references public.captions(id) on delete cascade,
 version_number integer not null check(version_number>0),
 image_path text not null, caption text not null check(length(caption) between 1 and 280),
 model text not null, user_prompt text not null, generation_prompt text not null,
 published_at timestamptz not null, created_at timestamptz not null default now(), archived_at timestamptz,
 unique(caption_id,version_number), unique(caption_id,id)
);
alter table public.captions add column active_version_id uuid, add column feed_published_at timestamptz;
insert into public.caption_versions(caption_id,version_number,image_path,caption,model,user_prompt,generation_prompt,published_at,created_at)
 select id,1,image_path,caption,model,user_prompt,generation_prompt,created_at,created_at from public.captions;
-- Disable only the activity stamp during backfill: original revision timestamps survive.
alter table public.captions disable trigger caption_edit_timestamp;
update public.captions c set active_version_id=v.id,feed_published_at=v.published_at from public.caption_versions v where v.caption_id=c.id;
alter table public.captions enable trigger caption_edit_timestamp;
alter table public.captions alter column active_version_id set not null,alter column feed_published_at set not null;
alter table public.captions add constraint captions_active_version_fk foreign key(id,active_version_id) references public.caption_versions(caption_id,id) deferrable initially deferred;
create index captions_publication_idx on public.captions(feed_published_at desc,id desc);
create index captions_owner_publication_idx on public.captions(creator_id,feed_published_at desc,id desc);
create index caption_versions_image_idx on public.caption_versions(image_path);
alter table public.caption_votes add column version_id uuid;
update public.caption_votes v set version_id=c.active_version_id from public.captions c where c.id=v.caption_id;
alter table public.caption_votes alter column version_id set not null;
alter table public.caption_votes drop constraint caption_votes_one_per_user;
alter table public.caption_votes add constraint caption_votes_one_per_version unique(user_id,version_id),
 add constraint caption_votes_version_fk foreign key(caption_id,version_id) references public.caption_versions(caption_id,id) on delete cascade;
create index caption_votes_version_idx on public.caption_votes(version_id,value);
alter table public.caption_versions enable row level security;
revoke all on public.caption_versions from public,anon,authenticated;
grant select(id,caption_id,version_number,image_path,caption,model,published_at,created_at,archived_at) on public.caption_versions to authenticated;
grant all on public.caption_versions to service_role;
create policy caption_history_owner on public.caption_versions for select to authenticated using (exists(select 1 from public.captions c where c.id=caption_id and c.creator_id=(select auth.uid())));
alter table public.caption_mutations drop constraint caption_mutations_operation_check;
alter table public.caption_mutations add constraint caption_mutations_operation_check check(operation in ('edit','delete','restore'));

-- A new logical record gets its first immutable published version in the same transaction.
create function public.caption_initial_version() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.active_version_id:=gen_random_uuid(); new.feed_published_at:=new.created_at;
 return new;
end $$;
create function public.caption_insert_version() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.caption_versions(id,caption_id,version_number,image_path,caption,model,user_prompt,generation_prompt,published_at)
 values(new.active_version_id,new.id,1,new.image_path,new.caption,new.model,new.user_prompt,new.generation_prompt,new.feed_published_at);
 return new;
end $$;
create trigger caption_initial_version before insert on public.captions for each row execute function public.caption_initial_version();
create trigger caption_insert_version after insert on public.captions for each row execute function public.caption_insert_version();
create function public.caption_version_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if (to_jsonb(new)-'archived_at') is distinct from (to_jsonb(old)-'archived_at') then raise exception 'Published version content is immutable'; end if;
 return new;
end $$;
create trigger caption_version_immutable before update on public.caption_versions for each row execute function public.caption_version_immutable();
-- The row lock serializes voting with publication/restoration. Direct RLS-backed
-- INSERT/UPDATE also rejects archived versions; only the value may be updated.
create function public.caption_vote_active_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare active uuid;
begin
 select active_version_id into active from public.captions where id=new.caption_id for update;
 if active is null then raise exception 'Slide not found' using errcode='23503'; end if;
 if tg_op='INSERT' and new.version_id is null then new.version_id:=active; end if;
 if new.version_id is distinct from active then raise exception 'This version is archived. Reload before voting.' using errcode='40001'; end if;
 if tg_op='UPDATE' and (new.user_id,new.caption_id,new.version_id) is distinct from (old.user_id,old.caption_id,old.version_id) then raise exception 'Vote identity is immutable'; end if;
 return new;
end $$;
create trigger caption_vote_active_guard before insert or update on public.caption_votes for each row execute function public.caption_vote_active_guard();
grant insert(version_id) on public.caption_votes to authenticated;
-- Backwards-compatible SQL entry point, but all browser votes supply an expected version.
create or replace function public.cast_caption_vote(target_caption uuid,vote_value boolean) returns void language plpgsql security invoker set search_path='' as $$
begin
 insert into public.caption_votes(user_id,caption_id,value) values(auth.uid(),target_caption,vote_value)
 on conflict(user_id,version_id) do update set value=excluded.value;
end $$;
create or replace function public.caption_edit_save(actor uuid,target uuid,draft_id uuid,fingerprint text,candidate_version uuid,selection integer,saved_path text,expected_at timestamptz,request_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.captions%rowtype; d public.caption_drafts%rowtype; previous public.caption_mutations%rowtype; result jsonb; next_id uuid; next_number integer; publication timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  select * into previous from public.caption_mutations where user_id=actor and token=request_token;
  if found then
    if previous.target_id<>target or previous.operation<>'edit' then raise exception 'Invalid mutation token'; end if;
    return previous.result;
  end if;
  select * into c from public.captions where id=target and creator_id=actor for update;
  if not found then raise exception 'Slide not found' using errcode='42501'; end if;
  if c.updated_at is distinct from expected_at then raise exception 'This slide changed in another window. Reopen it before saving.' using errcode='40001'; end if;
  select * into d from public.caption_drafts where id=draft_id and user_id=actor for update;
  if not found or d.image_hash is distinct from fingerprint or d.expires_at<=now() or d.version is distinct from candidate_version or d.candidates is null or selection is null or selection not between 0 and 2 then raise exception 'Choose a current generated caption for this image'; end if;
  update public.caption_generation_requests set status='uncertain' where caption_generation_requests.draft_id=d.id and status='pending' and created_at<=now()-interval '2 minutes';
  if exists(select 1 from public.caption_generation_requests r where r.draft_id=d.id and status='pending') then raise exception 'Generation still in progress'; end if;
  if saved_path<>c.image_path and (saved_path not like actor::text||'/'||d.id::text||'-%' or not exists(select 1 from storage.objects where bucket_id='caption-images' and name=saved_path and owner_id=actor::text)) then raise exception 'Image ownership could not be verified'; end if;
  if c.image_path is distinct from saved_path or c.caption is distinct from d.candidates[selection+1] then
    next_id:=gen_random_uuid(); publication:=clock_timestamp();
    select max(version_number)+1 into next_number from public.caption_versions where caption_id=c.id;
    update public.caption_versions set archived_at=publication where id=c.active_version_id;
    insert into public.caption_versions(id,caption_id,version_number,image_path,caption,model,user_prompt,generation_prompt,published_at)
    values(next_id,c.id,next_number,saved_path,d.candidates[selection+1],d.model,'Image-only caption generation',d.generation_prompt,publication);
    update public.captions set active_version_id=next_id,feed_published_at=publication,image_path=saved_path,caption=d.candidates[selection+1],model=d.model,generation_prompt=d.generation_prompt,user_prompt='Image-only caption generation' where id=c.id;
  end if;
  update public.caption_drafts set expires_at='infinity' where id=d.id;
  -- Historical image references remain live; replacement never enqueues deletion.
  select jsonb_build_object('id',id,'updated_at',updated_at,'version_id',active_version_id) into result from public.captions where id=c.id;
  insert into public.caption_mutations values(actor,request_token,target,'edit',result);
  return result;
end $$;
create or replace function public.caption_delete_own(actor uuid,target uuid,request_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.captions%rowtype; previous public.caption_mutations%rowtype; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  select * into previous from public.caption_mutations where user_id=actor and token=request_token;
  if found then
    if previous.target_id<>target or previous.operation<>'delete' then raise exception 'Invalid mutation token'; end if;
    return previous.result;
  end if;
  select * into c from public.captions where id=target and creator_id=actor for update;
  if not found then
    select * into previous from public.caption_mutations where user_id=actor and target_id=target and operation='delete' limit 1;
    if found then return previous.result; end if;
    raise exception 'Slide not found' using errcode='42501';
  end if;
  update public.caption_drafts set candidates=null,model=null,generation_prompt=null,expires_at=now() where finalized_id=target;
  insert into public.caption_storage_gc(path,user_id)
    select distinct v.image_path,actor from public.caption_versions v where v.caption_id=target
    and not exists(select 1 from public.caption_versions other where other.image_path=v.image_path and other.caption_id<>target) on conflict do nothing;
  delete from public.captions where id=target;
  -- caption_votes already has ON DELETE CASCADE. Generation counter tombstones survive.
  result:=jsonb_build_object('id',target,'deleted',true);
  insert into public.caption_mutations values(actor,request_token,target,'delete',result);
  return result;
end $$;

create or replace function public.caption_storage_cleanup_paths(actor uuid) returns table(path text)
language sql stable security definer set search_path='' as $$
  select g.path from public.caption_storage_gc g where user_id=actor and cleaned_at is null
  and not exists(select 1 from public.caption_versions v where v.image_path=g.path) order by queued_at limit 20;
$$;
create function public.caption_restore_version(actor uuid,target uuid,historical uuid,expected_at timestamptz,request_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.captions%rowtype; v public.caption_versions%rowtype; previous public.caption_mutations%rowtype; result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
 select * into previous from public.caption_mutations where user_id=actor and token=request_token;
 if found then
   if previous.target_id<>target or previous.operation<>'restore' or previous.result->>'version_id'<>historical::text then raise exception 'Invalid mutation token'; end if;
   return previous.result;
 end if;
 select * into c from public.captions where id=target and creator_id=actor for update;
 if not found then raise exception 'Slide not found' using errcode='42501'; end if;
 select * into v from public.caption_versions where id=historical and caption_id=target;
 if not found then raise exception 'Version not found' using errcode='42501'; end if;
 if c.active_version_id<>v.id then
   if c.updated_at is distinct from expected_at then raise exception 'Slide changed. Reopen before restoring.' using errcode='40001'; end if;
   update public.caption_versions set archived_at=clock_timestamp() where id=c.active_version_id;
   update public.caption_versions set archived_at=null where id=v.id;
   update public.captions set active_version_id=v.id,feed_published_at=v.published_at,image_path=v.image_path,caption=v.caption,model=v.model,user_prompt=v.user_prompt,generation_prompt=v.generation_prompt where id=c.id;
 end if;
 select jsonb_build_object('id',id,'version_id',active_version_id,'updated_at',updated_at) into result from public.captions where id=c.id;
 insert into public.caption_mutations values(actor,request_token,target,'restore',result);
 return result;
end $$;
revoke all on function public.caption_restore_version(uuid,uuid,uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.caption_restore_version(uuid,uuid,uuid,timestamptz,uuid) to service_role;

-- Active item shape includes the version token used to reject stale browser votes.
create function public.caption_active_items(caption_ids uuid[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if coalesce(cardinality(caption_ids),0)>48 then raise exception 'At most 48 caption IDs'; end if;
 select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at desc,item.id desc),'[]'::jsonb) into result from (
 select c.id,c.image_path,c.caption,c.model,c.feed_published_at as created_at,c.updated_at,c.active_version_id as version_id,v.version_number,
   (select count(*) from public.caption_votes cv where cv.version_id=c.active_version_id and cv.value) as funny_count,
   (select count(*) from public.caption_votes cv where cv.version_id=c.active_version_id and not cv.value) as not_funny_count,
   (select cv.value from public.caption_votes cv where cv.version_id=c.active_version_id and cv.user_id=auth.uid()) as my_vote
 from public.captions c join public.caption_versions v on v.id=c.active_version_id where c.id=any(caption_ids)
 ) item;
 return result;
end $$;
revoke all on function public.caption_active_items(uuid[]) from public,anon;
grant execute on function public.caption_active_items(uuid[]) to authenticated;
create function public.caption_version_vote(target_caption uuid,expected_version uuid,vote_value boolean) returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if expected_version is null then raise exception 'Version required' using errcode='22023'; end if;
 insert into public.caption_votes(user_id,caption_id,version_id,value) values(auth.uid(),target_caption,expected_version,vote_value)
 on conflict(user_id,version_id) do update set value=excluded.value;
 return public.caption_active_items(array[target_caption])->0;
end $$;
revoke all on function public.caption_version_vote(uuid,uuid,boolean) from public,anon;
grant execute on function public.caption_version_vote(uuid,uuid,boolean) to authenticated;
create function public.caption_version_history(target uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.captions%rowtype; result jsonb;
begin
 select * into c from public.captions where id=target and creator_id=auth.uid();
 if not found then raise exception 'Slide not found' using errcode='42501'; end if;
 select jsonb_agg(jsonb_build_object('id',v.id,'version_number',v.version_number,'caption',v.caption,'published_at',v.published_at,'active',v.id=c.active_version_id,
 'funny_count',(select count(*) from public.caption_votes cv where cv.version_id=v.id and cv.value),
 'not_funny_count',(select count(*) from public.caption_votes cv where cv.version_id=v.id and not cv.value)) order by v.version_number desc) into result from public.caption_versions v where v.caption_id=target;
 return jsonb_build_object('versions',result,'item',public.caption_active_items(array[target])->0);
end $$;
revoke all on function public.caption_version_history(uuid) from public,anon;
grant execute on function public.caption_version_history(uuid) to authenticated;
create or replace function public.caption_deck_items(caption_ids uuid[])
returns table(id uuid,image_path text,caption text,model text,created_at timestamptz,funny_count bigint,not_funny_count bigint,my_vote boolean)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if coalesce(cardinality(caption_ids),0)>48 then raise exception 'At most 48 caption IDs' using errcode='22023'; end if;
  return query
    select c.id,c.image_path,c.caption,c.model,c.feed_published_at,
      coalesce(t.funny,0),coalesce(t.not_funny,0),mine.value
    from public.captions c
    left join lateral (
      select count(*) filter(where v.value) as funny,count(*) filter(where not v.value) as not_funny
      from public.caption_votes v where v.version_id=c.active_version_id
    ) t on true
    left join public.caption_votes mine on mine.version_id=c.active_version_id and mine.user_id=auth.uid()
    where c.id=any(caption_ids)
    order by c.feed_published_at desc,c.id desc;
end $$;
create or replace function public.caption_deck_snapshot(
  selected_month text default null,
  seen_created_at timestamptz default null,
  seen_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  caller uuid := auth.uid();
  slide_rows jsonb;
  latest public.captions%rowtype;
  fresh bigint := 0;
begin
  if caller is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'created_at',c.feed_published_at,'version_id',c.active_version_id,'updated_at',c.updated_at,'my_vote',v.value)
    order by c.feed_published_at desc,c.id desc),'[]'::jsonb) into slide_rows
  from public.captions c
  left join public.caption_votes v on v.version_id=c.active_version_id and v.user_id=caller;
  select * into latest from public.captions c order by c.updated_at desc,c.id desc limit 1;
  if seen_created_at is not null then
    select count(*) into fresh from public.captions c
      where (c.updated_at,c.id) > (seen_created_at,coalesce(seen_id,'00000000-0000-0000-0000-000000000000'::uuid));
  end if;
  return jsonb_build_object('slides',slide_rows,
    'latest',case when latest.id is null then null else jsonb_build_object('id',latest.id,'created_at',latest.created_at,'updated_at',latest.updated_at) end,
    'new_count',fresh);
end $$;
create or replace function public.caption_feed(sort_by text default 'newest', page_offset integer default 0, page_size integer default 12)
returns table(id uuid,image_path text,caption text,model text,created_at timestamptz,funny_count bigint,not_funny_count bigint,my_vote boolean)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  return query
    select c.id,c.image_path,c.caption,c.model,c.feed_published_at,
      coalesce(v.funny,0),coalesce(v.not_funny,0),mine.value
    from public.captions c
    left join (select cv.version_id,count(*) filter(where cv.value) funny,count(*) filter(where not cv.value) not_funny from public.caption_votes cv group by cv.version_id) v on v.version_id=c.active_version_id
    left join public.caption_votes mine on mine.version_id=c.active_version_id and mine.user_id=auth.uid()
    order by case when sort_by='top' then coalesce(v.funny,0)-coalesce(v.not_funny,0) else 0 end desc,c.feed_published_at desc,c.id desc
    limit least(greatest(page_size,1),48) offset least(greatest(page_offset,0),10000);
end $$;

create or replace function public.my_caption_page(after_time timestamptz default null,after_id uuid default null,page_size integer default 24)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare ids uuid[];
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select array_agg(c.id order by c.feed_published_at desc,c.id desc) into ids from (
 select id,feed_published_at from public.captions where creator_id=auth.uid() and (after_time is null or (feed_published_at,id)<(after_time,after_id))
 order by feed_published_at desc,id desc limit least(greatest(page_size,1),24)+1
 ) c;
 return jsonb_build_object('items',public.caption_active_items(coalesce(ids,'{}'::uuid[])));
end $$;
-- Storage policy helpers expose only a boolean, never historical paths/content.
create function public.caption_image_access(object_path text, deleting boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select case when deleting then not exists(select 1 from public.caption_versions where image_path=object_path)
 else auth.uid() is not null and (exists(select 1 from public.captions where image_path=object_path) or split_part(object_path,'/',1)=auth.uid()::text) end;
$$;
revoke all on function public.caption_image_access(text,boolean) from public,anon;
grant execute on function public.caption_image_access(text,boolean) to authenticated;
create policy caption_history_storage_read_fence on storage.objects as restrictive for select to authenticated using(bucket_id<>'caption-images' or public.caption_image_access(name));
create policy caption_history_storage_delete_fence on storage.objects as restrictive for delete to authenticated using(bucket_id<>'caption-images' or public.caption_image_access(name,true));
revoke all on function public.caption_initial_version(),public.caption_insert_version(),public.caption_version_immutable(),public.caption_vote_active_guard() from public,anon,authenticated;
-- Locate the owner's current page without walking pages in the browser after restoration.
create function public.my_caption_page_containing(target uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare position bigint; boundary bigint; cursors jsonb; page jsonb; cursor_time timestamptz; cursor_id uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select ordinal-1 into position from (select id,row_number() over(order by feed_published_at desc,id desc) ordinal from public.captions where creator_id=auth.uid()) c where id=target;
 if position is null then raise exception 'Slide not found' using errcode='42501'; end if;
 boundary:=(position/24)*24;
 select jsonb_build_array(null)||coalesce(jsonb_agg(jsonb_build_object('time',feed_published_at,'id',id) order by ordinal),'[]'::jsonb) into cursors
 from (select id,feed_published_at,row_number() over(order by feed_published_at desc,id desc) ordinal from public.captions where creator_id=auth.uid()) c where ordinal%24=0 and ordinal<=boundary;
 if boundary>0 then cursor_time:=(cursors->-1->>'time')::timestamptz; cursor_id:=(cursors->-1->>'id')::uuid; end if;
 page:=public.my_caption_page(cursor_time,cursor_id,24);
 return page||jsonb_build_object('cursors',cursors);
end $$;
revoke all on function public.my_caption_page_containing(uuid) from public,anon;
grant execute on function public.my_caption_page_containing(uuid) to authenticated;
commit;
