begin;
set local search_path=pg_catalog,pg_temp;
do $$ declare helper record; implementation record; begin
 if current_user<>'postgres' or session_user<>'postgres' then raise exception 'Run in a postgres session'; end if;
 -- Fail closed on schema/helper drift rather than silently broadening a changed
 -- creator helper. Hashes identify reviewed bodies, including whitespace.
 for helper in select * from (values
 ('public.caption_restore_version(uuid,uuid,uuid,timestamptz,uuid)','adf0148039682360db884c9ee7326176',false),
 ('public.admin_assert()','eb49fcb68b930fca10afd45d5d6c3345',false),
 ('public.admin_generation(text,uuid,text,text[],text,boolean)','557ed50ab14aa62cf4a86f11e2d822b5',true),
 ('public.admin_media_generation(uuid,text,uuid,text,text[],text,boolean)','c86b3373644e8ebb6ec91758a4c39348',true),
 ('public.caption_generation_reserve(uuid,text,uuid,integer,integer)','9468179bc19034b4547f0732fa7e42dd',false),
 ('public.caption_generation_finish(uuid,uuid,text[],text,text,boolean)','ce703bdc85f8d9151737751f87da24b4',false),
 ('public.caption_draft_state(uuid,uuid)','6dcb1a2f82afdb3b7c1e9fac5294c78c',false),
 ('public.cleanup_caption_drafts()','6a3349f7876159673d868d3ac1a463d6',false)
 ) as reviewed(signature,source_hash,browser_access) loop
 select p.* into implementation from pg_proc p where p.oid=to_regprocedure(helper.signature);
 if not found then raise exception 'Missing reviewed prerequisite: %',helper.signature; end if;
 if md5(implementation.prosrc)<>helper.source_hash or implementation.proowner<>'postgres'::regrole
 or not implementation.prosecdef or not coalesce('search_path=""'=any(implementation.proconfig),false)
 or has_function_privilege('anon',implementation.oid,'execute')
 or has_function_privilege('authenticated',implementation.oid,'execute')<>helper.browser_access then
 raise exception 'Prerequisite differs from reviewed implementation or grants: %',helper.signature; end if;
 end loop;
 if not has_function_privilege('service_role','public.caption_restore_version(uuid,uuid,uuid,timestamptz,uuid)','execute') then
 raise exception 'Creator restore helper must remain service-only'; end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('admin_restore_version','admin_generation_v2','admin_media_generation_v2')) then
 raise exception 'Migration 004 functions already exist; review before applying'; end if;
 if exists(select 1 from pg_class where oid in ('public.captions'::regclass,'public.caption_versions'::regclass,'public.caption_votes'::regclass) and not relrowsecurity) then
 raise exception 'Original caption RLS must remain enabled'; end if;
 if exists(select 1 from public.captions c left join public.caption_versions v on v.id=c.active_version_id and v.caption_id=c.id
 where v.id is null or v.archived_at is not null or c.feed_published_at is distinct from v.published_at
 or (c.image_path,c.caption,c.model,c.user_prompt,c.generation_prompt) is distinct from (v.image_path,v.caption,v.model,v.user_prompt,v.generation_prompt))
 or exists(select 1 from public.caption_versions v join public.captions c on c.id=v.caption_id where v.id<>c.active_version_id and v.archived_at is null) then
 raise exception 'Existing active version state is inconsistent; review before applying'; end if;
end $$;
-- Forward only. Reuse the creator helper without broadening its service-only grants.
alter table public.admin_audit drop constraint admin_audit_operation_check;
alter table public.admin_audit add constraint admin_audit_operation_check check(operation in ('create','update','delete','restore'));

create function public.admin_restore_version(target uuid,historical uuid,expected_at timestamptz,request_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; owner_id uuid; previous public.admin_audit%rowtype; payload jsonb; result jsonb;
begin
 actor:=public.admin_assert();
 if target is null or historical is null or expected_at is null or request_token is null then
 raise exception 'Invalid restoration' using errcode='22023'; end if;
 payload:=jsonb_build_object('target',target,'historical',historical,'expected_at',expected_at);
 perform pg_advisory_xact_lock(hashtextextended('admin:'||actor::text,0));
 select * into previous from public.admin_audit where actor_id=actor and request_id=request_token;
 if found then
 if previous.operation<>'restore' or previous.details->'request' is distinct from payload then
 raise exception 'Request token reused' using errcode='22023'; end if;
 return previous.result;
 end if;
 select creator_id into owner_id from public.captions where id=target;
 if not found then raise exception 'Media not found' using errcode='P0002'; end if;
 -- Helper locks owner before caption, matching creator and admin edits/deletion.
 -- Use a private token in the owner's namespace, never the external admin token.
 result:=public.caption_restore_version(owner_id,target,historical,expected_at,gen_random_uuid());
 insert into public.admin_audit(actor_id,request_id,operation,target_id,details,result)
 values(actor,request_token,'restore',target,jsonb_build_object('request',payload),result);
 return result;
end $$;
alter function public.admin_restore_version(uuid,uuid,timestamptz,uuid) owner to postgres;
revoke all on function public.admin_restore_version(uuid,uuid,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_restore_version(uuid,uuid,timestamptz,uuid) to authenticated;

-- Carry the actual new request prompt; leave historical metadata untouched.
create function public.admin_generation_v2(phase text,token uuid,fingerprint text default null,choices text[] default null,used_model text default null,uncertain boolean default false,used_prompt text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; result jsonb;
begin
 actor:=public.admin_assert();
 if phase='reserve' then
  -- Never override per-image/daily quotas; suggestions share the existing allowance.
  result:=public.caption_generation_reserve(actor,fingerprint,token,12,24);
 elsif phase='finish' then
  result:=public.caption_generation_finish(actor,token,choices,used_model,coalesce(used_prompt,'Admin image-grounded Gemini caption suggestions'),uncertain);
 else raise exception 'Invalid generation phase' using errcode='22023'; end if;
 return result;
end $$;
alter function public.admin_generation_v2(text,uuid,text,text[],text,boolean,text) owner to postgres;
revoke all on function public.admin_generation_v2(text,uuid,text,text[],text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_generation_v2(text,uuid,text,text[],text,boolean,text) to authenticated;

-- Carry the actual new request prompt; leave historical metadata untouched.
create function public.admin_media_generation_v2(media_id uuid,phase text,token uuid default null,fingerprint text default null,choices text[] default null,used_model text default null,uncertain boolean default false,used_prompt text default null)
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
   where i.user_id=actor and i.media_id=admin_media_generation_v2.media_id and i.image_path=source_path;
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
  result:=public.admin_generation_v2('reserve',token,fingerprint);
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
  draft:=public.admin_generation_v2('finish',token,null,choices,used_model,uncertain,used_prompt);
  result:=jsonb_build_object('dispatch',false,'status',(select r.status from public.caption_generation_requests r where r.user_id=actor and r.request_id=token),'draft',draft);
 end if;
 select coalesce(q.used,0),coalesce(q.dispatched,0) into used_count,dispatch_count from public.caption_generation_days q where q.user_id=actor and q.day=today;
 return result || jsonb_build_object('protocol',1,'allowance',jsonb_build_object(
  'imageRemaining',coalesce((draft->>'remaining')::integer,3),
  'dailyRemaining',greatest(0,12-coalesce(used_count,0)),
  'dispatchRemaining',greatest(0,24-coalesce(dispatch_count,0)),
  'resetsAt',((today+1)::timestamp at time zone 'UTC')));
end $$;
alter function public.admin_media_generation_v2(uuid,text,uuid,text,text[],text,boolean,text) owner to postgres;
revoke all on function public.admin_media_generation_v2(uuid,text,uuid,text,text[],text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_media_generation_v2(uuid,text,uuid,text,text[],text,boolean,text) to authenticated;
do $$ declare f record; g record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('admin_restore_version','admin_generation_v2','admin_media_generation_v2') loop
 for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
 where p.oid=f.signature::oid and a.grantee<>p.proowner and r.rolname<>'authenticated' loop
 execute format('revoke all on function %s from %I cascade',f.signature,g.rolname);
 end loop;
 end loop;
end $$;
commit;
