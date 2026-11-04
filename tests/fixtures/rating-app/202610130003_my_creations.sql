-- Personal slide management; apply after 202610130002. Existing slide IDs and votes survive edits.
begin;
alter table public.captions add column updated_at timestamptz;
update public.captions set updated_at=created_at;
alter table public.captions alter column updated_at set default now(), alter column updated_at set not null;
create index captions_activity_idx on public.captions(updated_at desc,id desc);
create index captions_owner_activity_idx on public.captions(creator_id,updated_at desc,id desc);
create function public.stamp_caption_edit() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then new.updated_at=new.created_at; else new.updated_at=greatest(clock_timestamp(),old.updated_at+interval '1 microsecond'); end if;
  return new;
end $$;
create trigger caption_edit_timestamp before insert or update on public.captions for each row execute function public.stamp_caption_edit();
revoke all on function public.stamp_caption_edit() from public,anon,authenticated;
-- Keep the latest batch usable for future edits of published images. Unused drafts
-- still expire after seven days; counters remain persistent in either case.
update public.caption_drafts set expires_at='infinity' where finalized_id is not null and candidates is not null;
-- A deleted caption must not be held alive by its generation draft.
alter table public.caption_drafts drop constraint caption_drafts_finalized_id_fkey;
alter table public.caption_drafts add constraint caption_drafts_finalized_id_fkey foreign key(finalized_id) references public.captions(id) on delete set null;
create table public.caption_mutations (
  user_id uuid not null references auth.users(id) on delete cascade,
  token uuid not null, target_id uuid not null,
  operation text not null check(operation in ('edit','delete')),
  result jsonb not null,
  primary key(user_id,token)
);
create table public.caption_storage_gc (
  path text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  queued_at timestamptz not null default now(), cleaned_at timestamptz
);
alter table public.caption_mutations enable row level security;
alter table public.caption_storage_gc enable row level security;
revoke all on public.caption_mutations,public.caption_storage_gc from public,anon,authenticated;
grant all on public.caption_mutations,public.caption_storage_gc to service_role;
-- Retain path tombstones so a new reference cannot race with asynchronous Storage deletion.
create function public.guard_retired_caption_image() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and new.image_path=old.image_path then return new; end if;
  if exists(select 1 from public.caption_storage_gc where path=new.image_path) then raise exception 'This image path has been retired'; end if;
  return new;
end $$;
create trigger caption_image_retirement before insert or update of image_path on public.captions for each row execute function public.guard_retired_caption_image();
revoke all on function public.guard_retired_caption_image() from public,anon,authenticated;

create function public.my_caption_page(after_time timestamptz default null, after_id uuid default null, page_size integer default 24)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare items jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(c) order by c.updated_at desc,c.id desc),'[]'::jsonb) into items from (
    select id,image_path,caption,model,created_at,updated_at from public.captions
    where creator_id=auth.uid() and (after_time is null or (updated_at,id)<(after_time,after_id))
    order by updated_at desc,id desc limit least(greatest(page_size,1),24)+1
  ) c;
  return jsonb_build_object('items',items);
end $$;
revoke all on function public.my_caption_page(timestamptz,uuid,integer) from public,anon;
grant execute on function public.my_caption_page(timestamptz,uuid,integer) to authenticated;

create or replace function public.caption_generation_reserve(actor uuid, fingerprint text, token uuid, daily_limit integer default 12, dispatch_limit integer default 24)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.caption_drafts%rowtype; r public.caption_generation_requests%rowtype; q public.caption_generation_days%rowtype;
  today date := (now() at time zone 'UTC')::date;
begin
  if actor is null or token is null or fingerprint !~ '^[a-f0-9]{64}$' or daily_limit not between 1 and 100 or dispatch_limit not between 1 and 200 then raise exception 'Invalid generation reservation'; end if;
  -- Serialize across all images for this user, including simultaneous first drafts.
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  insert into public.caption_drafts(user_id,image_hash) values(actor,fingerprint) on conflict(user_id,image_hash) do nothing;
  select * into d from public.caption_drafts where user_id=actor and image_hash=fingerprint for update;
  select * into r from public.caption_generation_requests where user_id=actor and request_id=token;
  if found then
    if r.draft_id<>d.id then raise exception 'Request ID belongs to another image'; end if;
    return jsonb_build_object('dispatch',false,'status',r.status,'draft',public.caption_draft_state(actor,d.id));
  end if;
  if d.finalized_id is not null and coalesce(current_setting('app.caption_edit_target',true),'')='' then return jsonb_build_object('dispatch',false,'status','finalized','draft',public.caption_draft_state(actor,d.id)); end if;
  -- A crashed or ambiguous request is never re-dispatched. Its reservation remains
  -- charged because Gemini may have processed it; this bounds calls after crashes.
  update public.caption_generation_requests set status='uncertain' where draft_id=d.id and status='pending' and created_at<=now()-interval '2 minutes';
  if exists(select 1 from public.caption_generation_requests where draft_id=d.id and status='pending') then
    return jsonb_build_object('dispatch',false,'status','pending','draft',public.caption_draft_state(actor,d.id));
  end if;
  if d.generations>=3 then return jsonb_build_object('dispatch',false,'status','image_limit','draft',public.caption_draft_state(actor,d.id)); end if;
  insert into public.caption_generation_days(user_id,day) values(actor,today) on conflict do nothing;
  select * into q from public.caption_generation_days where user_id=actor and day=today for update;
  if q.used>=daily_limit or q.dispatched>=dispatch_limit then return jsonb_build_object('dispatch',false,'status','daily_limit','draft',public.caption_draft_state(actor,d.id)); end if;
  update public.caption_generation_days set used=used+1,dispatched=dispatched+1 where user_id=actor and day=today;
  update public.caption_drafts set generations=generations+1,expires_at=case when expires_at='infinity'::timestamptz then expires_at else now()+interval '7 days' end where id=d.id;
  insert into public.caption_generation_requests(user_id,request_id,draft_id,day,status) values(actor,token,d.id,today,'pending');
  return jsonb_build_object('dispatch',true,'status','pending','draft',public.caption_draft_state(actor,d.id));
end $$;


-- A verified editing context permits remaining batches on an already published image.
-- Counters stay on the same user/image row; reopening never grants a fresh allowance.
create function public.caption_edit_reserve(actor uuid,target uuid,fingerprint text,token uuid,daily_limit integer default 12,dispatch_limit integer default 24)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  if not exists(select 1 from public.captions where id=target and creator_id=actor) then raise exception 'Slide not found' using errcode='42501'; end if;
  perform set_config('app.caption_edit_target',target::text,true);
  result:=public.caption_generation_reserve(actor,fingerprint,token,daily_limit,dispatch_limit);
  perform set_config('app.caption_edit_target','',true);
  return result;
end $$;

create function public.caption_edit_save(actor uuid,target uuid,draft_id uuid,fingerprint text,candidate_version uuid,selection integer,saved_path text,expected_at timestamptz,request_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.captions%rowtype; d public.caption_drafts%rowtype; previous public.caption_mutations%rowtype; result jsonb;
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
  update public.captions set image_path=saved_path,caption=d.candidates[selection+1],model=d.model,generation_prompt=d.generation_prompt,user_prompt='Image-only caption generation' where id=c.id;
  update public.caption_drafts set expires_at='infinity' where id=d.id;
  if c.image_path<>saved_path then insert into public.caption_storage_gc(path,user_id) values(c.image_path,actor) on conflict do nothing; end if;
  select jsonb_build_object('id',id,'updated_at',updated_at) into result from public.captions where id=c.id;
  insert into public.caption_mutations values(actor,request_token,target,'edit',result);
  return result;
end $$;

create function public.caption_delete_own(actor uuid,target uuid,request_token uuid)
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
  delete from public.captions where id=target;
  -- caption_votes already has ON DELETE CASCADE. Generation counter tombstones survive.
  insert into public.caption_storage_gc(path,user_id) values(c.image_path,actor) on conflict do nothing;
  result:=jsonb_build_object('id',target,'deleted',true);
  insert into public.caption_mutations values(actor,request_token,target,'delete',result);
  return result;
end $$;

create function public.caption_storage_cleanup_paths(actor uuid) returns table(path text)
language sql stable security definer set search_path='' as $$
  select g.path from public.caption_storage_gc g where user_id=actor and cleaned_at is null
  and not exists(select 1 from public.captions c where c.image_path=g.path) order by queued_at limit 20;
$$;
revoke all on function public.caption_edit_reserve(uuid,uuid,text,uuid,integer,integer),public.caption_edit_save(uuid,uuid,uuid,text,uuid,integer,text,timestamptz,uuid),public.caption_delete_own(uuid,uuid,uuid),public.caption_storage_cleanup_paths(uuid) from public,anon,authenticated;
grant execute on function public.caption_edit_reserve(uuid,uuid,text,uuid,integer,integer),public.caption_edit_save(uuid,uuid,uuid,text,uuid,integer,text,timestamptz,uuid),public.caption_delete_own(uuid,uuid,uuid),public.caption_storage_cleanup_paths(uuid) to service_role;
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
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'created_at',c.created_at,'updated_at',c.updated_at,'my_vote',v.value)
    order by c.updated_at desc,c.id desc),'[]'::jsonb) into slide_rows
  from public.captions c
  left join public.caption_votes v on v.caption_id=c.id and v.user_id=caller;
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
    select c.id,c.image_path,c.caption,c.model,c.created_at,
      coalesce(v.funny,0),coalesce(v.not_funny,0),mine.value
    from public.captions c
    left join (select cv.caption_id,count(*) filter(where cv.value) funny,count(*) filter(where not cv.value) not_funny from public.caption_votes cv group by cv.caption_id) v on v.caption_id=c.id
    left join public.caption_votes mine on mine.caption_id=c.id and mine.user_id=auth.uid()
    order by case when sort_by='top' then coalesce(v.funny,0)-coalesce(v.not_funny,0) else 0 end desc,c.updated_at desc,c.id
    limit least(greatest(page_size,1),48) offset least(greatest(page_offset,0),10000);
end $$;

create or replace function public.caption_draft_finalize(actor uuid, target uuid, fingerprint text, candidate_version uuid, selection integer, saved_path text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.caption_drafts%rowtype; caption_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  select * into d from public.caption_drafts where id=target and user_id=actor for update;
  if not found or d.image_hash<>fingerprint then raise exception 'Draft does not match this image'; end if;
  if d.finalized_id is not null then return jsonb_build_object('id',d.finalized_id); end if;
  if d.expires_at<=now() or d.version is distinct from candidate_version or d.candidates is null or selection not between 0 and 2 or selection is null then raise exception 'Select a current caption from this draft'; end if;
  update public.caption_generation_requests set status='uncertain' where draft_id=d.id and status='pending' and created_at<=now()-interval '2 minutes';
  if exists(select 1 from public.caption_generation_requests where draft_id=d.id and status='pending') then raise exception 'Generation is still in progress'; end if;
  if saved_path not like actor::text||'/'||d.id::text||'-%' or not exists(select 1 from storage.objects where bucket_id='caption-images' and name=saved_path and owner_id=actor::text) then raise exception 'Image ownership could not be verified'; end if;
  insert into public.captions(creator_id,image_path,user_prompt,generation_prompt,caption,model)
    values(actor,saved_path,'Image-only caption generation',d.generation_prompt,d.candidates[selection+1],d.model) returning id into caption_id;
  update public.caption_drafts set finalized_id=caption_id,expires_at='infinity' where id=d.id;
  return jsonb_build_object('id',caption_id);
end $$;


commit;
