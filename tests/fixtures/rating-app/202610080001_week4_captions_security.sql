-- Mock Humor Study / Week 4. Run as project owner in Supabase SQL Editor.
-- Transactional: unexpected existing profile schemas fail without partial changes.
begin;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='id' and udt_name='uuid')
     or (select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name in ('first_name','last_name','avatar_url') and data_type in ('text','character varying')) <> 3 then
    raise exception 'Expected profiles(id uuid, first_name text, last_name text, avatar_url text). Inspect your schema before adapting this migration.';
  end if;
end $$;

create table public.captions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  image_path text not null unique check (length(image_path) between 1 and 200 and split_part(image_path,'/',1)=creator_id::text),
  user_prompt text not null check (length(btrim(user_prompt)) between 1 and 1000),
  generation_prompt text not null check (length(generation_prompt) between 1 and 5000),
  caption text not null check (length(btrim(caption)) between 1 and 280),
  model text not null check (length(model) between 1 and 100),
  created_at timestamptz not null default now()
);
create table public.caption_votes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  caption_id uuid not null references public.captions(id) on delete cascade,
  value boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caption_votes_one_per_user unique (user_id, caption_id)
);
create index captions_newest_idx on public.captions(created_at desc, id);
create index captions_creator_idx on public.captions(creator_id);
create index caption_votes_caption_idx on public.caption_votes(caption_id, value);

-- Every public application table gets RLS, including any legacy tables.
-- Unrecognized tables keep their policies; inspect them using security_audit.sql.
do $$ declare t record; p record; c record;
begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  -- REPLACE, do not layer over old permissive policies on the app's known tables.
  for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in ('profiles','movies','captions','caption_votes') loop
    execute format('drop policy %I on public.%I',p.policyname,p.tablename);
  end loop;
  for t in select tablename from pg_tables where schemaname='public' and tablename in ('profiles','movies','captions','caption_votes') loop
    execute format('revoke all on public.%I from public, anon, authenticated',t.tablename);
    -- Table-level REVOKE does not clear previous column-level grants.
    for c in select column_name from information_schema.columns where table_schema='public' and table_name=t.tablename loop
      execute format('revoke select (%I), insert (%I), update (%I), references (%I) on public.%I from public, anon, authenticated', c.column_name,c.column_name,c.column_name,c.column_name,t.tablename);
    end loop;
  end loop;
end $$;

-- Private account/profile data remains owner-only. No role/email fields editable.
grant select (id,first_name,last_name,avatar_url), update (first_name,last_name,avatar_url) on public.profiles to authenticated;
create policy profiles_owner_read on public.profiles for select to authenticated using (id=(select auth.uid()));
create policy profiles_owner_update on public.profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));
-- Existing auth profile-creation triggers continue to run as their existing owner.
-- No browser profile INSERT or DELETE is granted.

do $$ begin
  if to_regclass('public.movies') is not null then
    execute 'grant select on public.movies to authenticated';
    execute 'create policy movies_member_read on public.movies for select to authenticated using ((select auth.uid()) is not null)';
  end if;
end $$;

grant select on public.captions to authenticated;
grant insert (creator_id,image_path,user_prompt,generation_prompt,caption,model) on public.captions to authenticated;
create policy captions_owner_read on public.captions for select to authenticated using (creator_id=(select auth.uid()));
create policy captions_owner_insert on public.captions for insert to authenticated with check (
  creator_id=(select auth.uid()) and exists (
    select 1 from storage.objects o where o.bucket_id='caption-images' and o.name=image_path and o.owner_id=(select auth.uid())::text
  )
);
grant select on public.caption_votes to authenticated;
grant insert (user_id,caption_id,value), update (value) on public.caption_votes to authenticated;
create policy votes_owner_read on public.caption_votes for select to authenticated using (user_id=(select auth.uid()));
create policy votes_owner_insert on public.caption_votes for insert to authenticated with check (user_id=(select auth.uid()));
create policy votes_owner_update on public.caption_votes for update to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));

create function public.stamp_caption_vote() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
create trigger caption_vote_updated before update on public.caption_votes for each row execute function public.stamp_caption_vote();
revoke all on function public.stamp_caption_vote() from public, anon, authenticated;

-- Invoker function: cannot bypass RLS or spoof caller identity. First vote INSERTS.
create function public.cast_caption_vote(target_caption uuid, vote_value boolean)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  insert into public.caption_votes(user_id,caption_id,value) values(auth.uid(),target_caption,vote_value)
  on conflict (user_id,caption_id) do update set value=excluded.value;
end $$;
revoke all on function public.cast_caption_vote(uuid,boolean) from public, anon;
grant execute on function public.cast_caption_vote(uuid,boolean) to authenticated;

-- Narrow definer interfaces are deliberate: expose only directory fields / totals,
-- not private profile columns, prompts, creator IDs, or other users' vote identities.
create function public.member_directory()
returns table(id uuid,first_name text,last_name text,avatar_url text)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return query select p.id,p.first_name::text,p.last_name::text,p.avatar_url::text from public.profiles p
    order by lower(coalesce(p.first_name,'')),lower(coalesce(p.last_name,'')),p.id;
end $$;
revoke all on function public.member_directory() from public, anon;
grant execute on function public.member_directory() to authenticated;

create function public.caption_feed(sort_by text default 'newest', page_offset integer default 0, page_size integer default 12)
returns table(id uuid,image_path text,caption text,model text,created_at timestamptz,funny_count bigint,not_funny_count bigint,my_vote boolean)
language sql stable security definer set search_path='' as $$
  select c.id,c.image_path,c.caption,c.model,c.created_at,
    coalesce(v.funny,0),coalesce(v.not_funny,0),mine.value
  from public.captions c
  left join (select caption_id,count(*) filter(where value) funny,count(*) filter(where not value) not_funny from public.caption_votes group by caption_id) v on v.caption_id=c.id
  left join public.caption_votes mine on mine.caption_id=c.id and mine.user_id=auth.uid()
  order by case when sort_by='top' then coalesce(v.funny,0)-coalesce(v.not_funny,0) else 0 end desc,c.created_at desc,c.id
  limit least(greatest(page_size,1),48) offset least(greatest(page_offset,0),10000);
$$;
revoke all on function public.caption_feed(text,integer,integer) from public;
grant execute on function public.caption_feed(text,integer,integer) to anon, authenticated;

-- Public images are intentional: captions are a public feed, and existing avatar
-- URLs use getPublicUrl. Only a user's UUID folder is writable by that user.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('caption-images','caption-images',true,3145728,array['image/jpeg','image/png','image/webp']),
       ('avatars','avatars',true,3145728,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- Supabase owns storage.objects and already enables its RLS.
-- Do not ALTER that managed table here; project-owner migration roles may lack ownership.
-- Drop policies that mention managed buckets, then add RESTRICTIVE fences too:
-- generic legacy policies might otherwise grant writes to every bucket.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='storage' and tablename='objects'
    and (coalesce(qual,'')||coalesce(with_check,'')) ~ '(avatars|caption-images)' loop
    execute format('drop policy %I on storage.objects',p.policyname);
  end loop;
end $$;
create policy study_image_read on storage.objects for select to anon,authenticated using (bucket_id in ('avatars','caption-images'));
create policy study_image_insert on storage.objects for insert to authenticated with check (bucket_id in ('avatars','caption-images') and (storage.foldername(name))[1]=(select auth.uid())::text and owner_id=(select auth.uid())::text);
create policy study_avatar_update on storage.objects for update to authenticated using (bucket_id='avatars' and (storage.foldername(name))[1]=(select auth.uid())::text) with check (bucket_id='avatars' and (storage.foldername(name))[1]=(select auth.uid())::text and owner_id=(select auth.uid())::text);
create policy study_image_delete on storage.objects for delete to authenticated using (bucket_id in ('avatars','caption-images') and (storage.foldername(name))[1]=(select auth.uid())::text and (bucket_id='avatars' or not exists(select 1 from public.captions c where c.image_path=name)));
create policy study_image_insert_fence on storage.objects as restrictive for insert to public with check (bucket_id not in ('avatars','caption-images') or (auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text and owner_id=auth.uid()::text));
create policy study_image_update_fence on storage.objects as restrictive for update to public using (bucket_id not in ('avatars','caption-images') or (bucket_id='avatars' and auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text)) with check (bucket_id not in ('avatars','caption-images') or (bucket_id='avatars' and auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text and owner_id=auth.uid()::text));
create policy study_image_delete_fence on storage.objects as restrictive for delete to public using (bucket_id not in ('avatars','caption-images') or (auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text and (bucket_id='avatars' or not exists(select 1 from public.captions c where c.image_path=name))));
commit;
