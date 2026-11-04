-- REVIEW ONLY / NOT APPLIED TO SUPABASE. Requires admin migrations 001 and 002.
-- Source website defaults: 3/user/image, 12 charged/day, 24 dispatches/day (UTC).
-- Confirm the original site's hosted CAPTION_DAILY_* values before approval;
-- different hosted overrides require a reviewed correction to both SQL limits.
begin;
set local search_path=pg_catalog,pg_temp;
do $$ declare helper record; implementation record; begin
 if current_user<>'postgres' or session_user<>'postgres' then raise exception 'Run in a postgres session'; end if;
 if to_regprocedure('public.admin_generation(text,uuid,text,text[],text,boolean)') is null then raise exception 'Review and apply admin generation migration 002 first'; end if;
 select p.* into implementation from pg_proc p
 where p.oid='public.admin_generation(text,uuid,text,text[],text,boolean)'::regprocedure;
 if md5(implementation.prosrc)<>'557ed50ab14aa62cf4a86f11e2d822b5'
 or implementation.proowner<>'postgres'::regrole or not implementation.prosecdef
 or not coalesce('search_path=""'=any(implementation.proconfig),false)
 or has_function_privilege('anon',implementation.oid,'execute')
 or has_function_privilege('service_role',implementation.oid,'execute') then
  raise exception 'Admin generation wrapper differs from reviewed migration 002';
 end if;
 if to_regprocedure('public.caption_generation_reserve(uuid,text,uuid,integer,integer)') is null
 or to_regprocedure('public.caption_generation_finish(uuid,uuid,text[],text,text,boolean)') is null
 or to_regprocedure('public.caption_draft_state(uuid,uuid)') is null
 or to_regprocedure('public.cleanup_caption_drafts()') is null then
  raise exception 'Original generation migration chain is incomplete';
 end if;
 if position('app.caption_edit_target' in pg_get_functiondef('public.caption_generation_reserve(uuid,text,uuid,integer,integer)'::regprocedure))=0 then
  raise exception 'Original reserve lacks reviewed published-image edit support; review original migration 202610130003 first';
 end if;
 -- Fail closed on hosted function drift. These hashes identify reviewed source
 -- bodies, not secrets or cryptographic authentication. Formatting drift also
 -- requires review; never overwrite a deployed helper automatically.
 for helper in select * from (values
  ('public.caption_generation_reserve(uuid,text,uuid,integer,integer)','9468179bc19034b4547f0732fa7e42dd'),
  ('public.caption_generation_finish(uuid,uuid,text[],text,text,boolean)','ce703bdc85f8d9151737751f87da24b4'),
  ('public.caption_draft_state(uuid,uuid)','6dcb1a2f82afdb3b7c1e9fac5294c78c'),
  ('public.cleanup_caption_drafts()','6a3349f7876159673d868d3ac1a463d6')
 ) as reviewed(signature,source_hash) loop
  select p.* into implementation from pg_proc p where p.oid=to_regprocedure(helper.signature);
  if md5(implementation.prosrc)<>helper.source_hash or not implementation.prosecdef
   or implementation.proowner<>'postgres'::regrole
   or not coalesce('search_path=""'=any(implementation.proconfig),false)
   or has_function_privilege('authenticated',implementation.oid,'execute')
   or has_function_privilege('anon',implementation.oid,'execute') then
   raise exception 'Original generation helper differs from reviewed implementation: %',helper.signature;
  end if;
 end loop;
end $$;
-- Private identity metadata only. Quotas remain exclusively in the original
-- generation tables. No media FK: an in-flight finish must survive deletion.
create table public.admin_generation_images (
 user_id uuid not null references auth.users(id) on delete cascade,
 media_id uuid not null, image_path text not null,
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 image_hash text not null check(image_hash ~ '^[a-f0-9]{64}$'),
 primary key(user_id,media_id,image_path)
);
create table public.admin_generation_bindings (
 user_id uuid not null references auth.users(id) on delete cascade,
 request_id uuid not null, media_id uuid not null, image_path text not null,
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 image_hash text not null check(image_hash ~ '^[a-f0-9]{64}$'),
 primary key(user_id,request_id)
);
alter table public.admin_generation_images owner to postgres;
alter table public.admin_generation_bindings owner to postgres;
alter table public.admin_generation_images enable row level security;
alter table public.admin_generation_bindings enable row level security;
revoke all on public.admin_generation_images,public.admin_generation_bindings from public,anon,authenticated,service_role;
-- Also remove arbitrary grants inherited from installation-specific defaults.
do $$ declare g record; begin
 for g in select distinct c.relname,r.rolname from pg_class c
 cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
 where c.oid in ('public.admin_generation_images'::regclass,'public.admin_generation_bindings'::regclass)
 and a.grantee<>c.relowner loop
 execute format('revoke all on table public.%I from %I cascade',g.relname,g.rolname);
 end loop;
end $$;
create function public.admin_media_generation(media_id uuid,phase text,token uuid default null,fingerprint text default null,choices text[] default null,used_model text default null,uncertain boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; result jsonb; draft jsonb; source_path text; source_owner uuid; known_hash text;
 used_count integer; dispatch_count integer; today date:=(now() at time zone 'UTC')::date; previous_context text; input_hash text:=fingerprint;
 binding public.admin_generation_bindings%rowtype; image public.admin_generation_images%rowtype;
begin
 actor:=public.admin_assert();
 if media_id is null or phase is null or phase not in ('state','reserve','finish') or fingerprint is null or fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'Invalid generation request' using errcode='22023'; end if;
 -- Same user-wide lock and tables as the rating website, never a new admin quota.
 perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
 if phase in ('reserve','finish') and token is null then
  raise exception 'Request token required' using errcode='22023';
 end if;
 select b.* into binding from public.admin_generation_bindings b
 where b.user_id=actor and b.request_id=token;
 if found and (binding.media_id<>media_id or binding.input_hash<>input_hash) then
  raise exception 'Request token belongs to another media or fingerprint' using errcode='22023';
 end if;
 if phase='finish' and binding.request_id is null then
  raise exception 'Unknown media generation request' using errcode='22023';
 end if;
 if phase<>'finish' then
  select image_path,creator_id into source_path,source_owner from public.captions where id=media_id;
  if not found then raise exception 'Media not found' using errcode='P0002'; end if;
  -- Original uploads retain their draft UUID in the image path. Preserve that
  -- canonical fingerprint and its existing allowance when it is available.
  select d.image_hash into known_hash from public.caption_drafts d
   where d.user_id=source_owner and source_path like source_owner::text||'/'||d.id::text||'-%' limit 1;
  if known_hash is not null then fingerprint:=known_hash; end if;
  select i.* into image from public.admin_generation_images i
   where i.user_id=actor and i.media_id=admin_media_generation.media_id and i.image_path=source_path;
  if found then
   if image.input_hash<>input_hash or image.image_hash<>fingerprint then
    raise exception 'Image fingerprint changed; review the stored image' using errcode='22023';
   end if;
  end if;
  if binding.request_id is not null and
   (binding.image_path<>source_path or binding.image_hash<>fingerprint) then
   raise exception 'Request token belongs to another image revision' using errcode='22023';
  end if;
 end if;
 if phase='state' then
  select public.caption_draft_state(actor,d.id) into draft from public.caption_drafts d where d.user_id=actor and d.image_hash=fingerprint;
  result:=jsonb_build_object('dispatch',false,'status',case when coalesce((draft->>'pending')::boolean,false) then 'pending' else 'ready' end,'draft',draft);
 elsif phase='reserve' then
  if binding.request_id is null then
   -- Do not adopt an unbound website/legacy token: its media provenance is unknown.
   if exists(select 1 from public.caption_generation_requests r where r.user_id=actor and r.request_id=token) then
    raise exception 'Request token already used outside this media workflow' using errcode='22023';
   end if;
   insert into public.admin_generation_bindings(user_id,request_id,media_id,image_path,input_hash,image_hash)
    values(actor,token,media_id,source_path,input_hash,fingerprint);
  end if;
  insert into public.admin_generation_images(user_id,media_id,image_path,input_hash,image_hash)
   values(actor,media_id,source_path,input_hash,fingerprint) on conflict do nothing;
  perform public.cleanup_caption_drafts();
  -- Published drafts normally reject new-create generations. This narrowly
  -- authorized edit context permits ONLY the existing remaining image allowance.
  previous_context:=coalesce(current_setting('app.caption_edit_target',true),'');
  perform set_config('app.caption_edit_target',media_id::text,true);
  result:=public.admin_generation('reserve',token,fingerprint);
  perform set_config('app.caption_edit_target',previous_context,true);
  draft:=result->'draft';
 else
  -- Finish an already dispatched request even if media was deleted meanwhile.
  -- The immutable binding authenticates both the media and the server-computed
  -- input fingerprint. Verify the original request still refers to its draft.
  if not exists(select 1 from public.caption_generation_requests r
   join public.caption_drafts d on d.id=r.draft_id and d.user_id=r.user_id
   where r.user_id=actor and r.request_id=token and d.image_hash=binding.image_hash) then
   raise exception 'Unknown or mismatched generation request' using errcode='22023';
  end if;
  draft:=public.admin_generation('finish',token,null,choices,used_model,uncertain);
  result:=jsonb_build_object('dispatch',false,'status',(select r.status from public.caption_generation_requests r where r.user_id=actor and r.request_id=token),'draft',draft);
 end if;
 select coalesce(q.used,0),coalesce(q.dispatched,0) into used_count,dispatch_count from public.caption_generation_days q where q.user_id=actor and q.day=today;
 return result || jsonb_build_object('protocol',1,'allowance',jsonb_build_object(
  'imageRemaining',coalesce((draft->>'remaining')::integer,3),
  'dailyRemaining',greatest(0,12-coalesce(used_count,0)),
  'dispatchRemaining',greatest(0,24-coalesce(dispatch_count,0)),
  'resetsAt',((today+1)::timestamp at time zone 'UTC')));
end $$;
alter function public.admin_media_generation(uuid,text,uuid,text,text[],text,boolean) owner to postgres;
revoke all on function public.admin_media_generation(uuid,text,uuid,text,text[],text,boolean) from public,anon,authenticated,service_role;
do $$ declare g record; begin
 for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid='public.admin_media_generation(uuid,text,uuid,text,text[],text,boolean)'::regprocedure and a.grantee<>p.proowner loop
 execute format('revoke all on function public.admin_media_generation(uuid,text,uuid,text,text[],text,boolean) from %I cascade',g.rolname);
 end loop;
end $$;
grant execute on function public.admin_media_generation(uuid,text,uuid,text,text[],text,boolean) to authenticated;
commit;
