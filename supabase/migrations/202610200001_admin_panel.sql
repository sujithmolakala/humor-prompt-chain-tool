-- PENDING APPLICATION. Apply ONCE as postgres, after the rating app's eleven migrations.
-- No existing content is deleted. No users are promoted. No existing RLS policy changes.
begin;
set local search_path=pg_catalog,pg_temp;
do $$ declare item text; begin
 if current_user <> 'postgres' or session_user <> 'postgres' then raise exception 'Run in a postgres session in SQL Editor'; end if;
 if to_regprocedure('public.admin_assert()') is not null or to_regclass('public.admin_audit') is not null then
 raise exception 'Admin migration already installed or conflicting objects exist'; end if;
 if to_regprocedure('public.caption_version_unvote(uuid,uuid)') is null
 or to_regprocedure('public.humor_hub_snapshot()') is null
 or to_regprocedure('public.caption_delete_own(uuid,uuid,uuid)') is null then
 raise exception 'Apply and verify the complete rating-app migration chain first'; end if;
 foreach item in array array['auth.users','public.profiles','public.captions','public.caption_versions','public.caption_votes','public.caption_drafts','public.caption_mutations','public.caption_storage_gc','public.hub_xp_events','public.hub_version_ratings','public.hub_achievements','storage.objects','storage.buckets'] loop
 if to_regclass(item) is null then raise exception 'Missing required relation: %',item; end if;
 end loop;
 foreach item in array array['public.hub_streak(uuid,date)','public.caption_restore_version(uuid,uuid,uuid,timestamp with time zone,uuid)','public.caption_image_access(text,boolean)','public.caption_storage_cleanup_paths(uuid)','public.caption_ranked_page(bigint)'] loop
 if to_regprocedure(item) is null then raise exception 'Missing required function: %',item; end if;
 end loop;
 -- Resolve all RPC field references before installing PL/pgSQL bodies (whose
 -- statements otherwise may not be parsed until the first live invocation).
 perform id,created_at from auth.users where false;
 perform id,first_name,last_name,avatar_url from public.profiles where false;
 perform id,creator_id,image_path,caption,model,user_prompt,generation_prompt,created_at,updated_at,active_version_id,feed_published_at from public.captions where false;
 perform id,caption_id,version_number,image_path,caption,model,user_prompt,generation_prompt,published_at,archived_at from public.caption_versions where false;
 perform id,user_id,caption_id,version_id,value,created_at,updated_at from public.caption_votes where false;
 perform user_id,amount from public.hub_xp_events where false;
 perform user_id from public.hub_version_ratings where false;
 perform user_id,achievement from public.hub_achievements where false;
 perform bucket_id,name,owner_id from storage.objects where false;
 -- FOR SHARE requires SELECT plus UPDATE on at least one column. Supabase
 -- owns auth.users separately; do not assume a hosted postgres role is a superuser.
 if not has_table_privilege('postgres','auth.users','SELECT')
 or not has_any_column_privilege('postgres','auth.users','UPDATE')
 or not has_table_privilege('postgres','public.profiles','SELECT')
 or not has_any_column_privilege('postgres','public.profiles','UPDATE') then
 raise exception 'postgres lacks privileges required for admin identity row locks'; end if;
 if not exists(select 1 from pg_constraint where conrelid='public.captions'::regclass and conname='captions_active_version_fk' and contype='f' and condeferrable and condeferred)
 or not exists(select 1 from pg_constraint where conrelid='public.caption_versions'::regclass and conname='caption_versions_caption_id_fkey' and confdeltype='c')
 or not exists(select 1 from pg_constraint where conrelid='public.caption_votes'::regclass and conname='caption_votes_version_fk' and confdeltype='c')
 or not exists(select 1 from pg_constraint where conrelid='public.caption_drafts'::regclass and conname='caption_drafts_finalized_id_fkey' and confdeltype='n') then
 raise exception 'Expected deferred version reference and deletion cascade constraints'; end if;
 if exists(select 1 from public.captions c left join public.caption_versions v on v.id=c.active_version_id and v.caption_id=c.id
 where v.id is null or v.archived_at is not null or v.published_at is distinct from c.feed_published_at
 or (v.image_path,v.caption,v.model,v.user_prompt,v.generation_prompt) is distinct from (c.image_path,c.caption,c.model,c.user_prompt,c.generation_prompt)) then
 raise exception 'Existing active caption versions are inconsistent; review before applying'; end if;
 if exists(select 1 from pg_class where oid in ('public.profiles'::regclass,'public.captions'::regclass,'public.caption_versions'::regclass,'public.caption_votes'::regclass,'storage.objects'::regclass) and not relrowsecurity) then
 raise exception 'Required rating-app RLS is disabled'; end if;
 if exists(select 1 from (values
 ('public.profiles','profiles_owner_read'),('public.profiles','profiles_owner_update'),
 ('public.captions','captions_creator_select_fence'),('public.captions','captions_creator_update_fence'),
 ('public.captions','captions_creator_delete_fence'),('public.caption_versions','versions_creator_select_fence'),
 ('storage.objects','study_image_insert_fence'),('storage.objects','study_image_update_fence'),
 ('storage.objects','study_image_delete_fence'),('storage.objects','caption_history_storage_read_fence'),
 ('storage.objects','caption_history_storage_delete_fence')) required(relation,name)
 where not exists(select 1 from pg_policy p where p.polrelid=to_regclass(required.relation) and p.polname=required.name)) then
 raise exception 'Missing required rating-app ownership or storage policy'; end if;
 -- Fail closed if the trusted-owner helper has drifted into an API-accessible RPC.
 if has_function_privilege('authenticated','public.caption_delete_own(uuid,uuid,uuid)','EXECUTE')
 or has_function_privilege('anon','public.caption_delete_own(uuid,uuid,uuid)','EXECUTE') then
 raise exception 'caption_delete_own must remain service-only'; end if;
 if not exists(select 1 from pg_proc where oid='public.caption_delete_own(uuid,uuid,uuid)'::regprocedure and prosecdef and pg_get_userbyid(proowner)='postgres' and proconfig @> array['search_path=""']) then
 raise exception 'Unexpected caption_delete_own security definition'; end if;
 if not exists(select 1 from storage.buckets where id='caption-images' and public is false) then
 raise exception 'Expected private caption-images bucket'; end if;
 if exists(select 1 from (values
 ('public.captions','caption_initial_version'),('public.captions','caption_insert_version'),
 ('public.captions','caption_edit_timestamp'),('public.captions','caption_original_identity'),
 ('public.captions','caption_image_retirement'),('public.captions','hub_creation_record'),
 ('public.caption_versions','caption_version_immutable'),('public.caption_votes','caption_vote_active_guard'),
 ('public.caption_votes','hub_vote_record')) required(relation,name)
 where not exists(select 1 from pg_trigger t where t.tgrelid=to_regclass(required.relation) and t.tgname=required.name and t.tgenabled in ('O','A') and not t.tgisinternal)) then
 raise exception 'Missing or disabled required rating-app trigger'; end if;
end $$;

-- An existing column could contain flags assigned by unrelated code. Do not
-- silently adopt it as an authorization source; a name collision must roll back.
alter table public.profiles add column is_superadmin boolean not null default false;
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='is_superadmin' and data_type='boolean' and is_nullable='NO' and column_default='false') then
 raise exception 'Unexpected existing is_superadmin definition; review before applying'; end if;
end $$;
revoke insert(is_superadmin),update(is_superadmin) on public.profiles from public,anon,authenticated,service_role;
grant select(is_superadmin) on public.profiles to authenticated;
-- Defense against legacy table-wide grants and profile provisioning that copies metadata.
create function public.admin_guard_role() returns trigger language plpgsql set search_path='' as $$
begin
 if ((tg_op='INSERT' and new.is_superadmin) or (tg_op='UPDATE' and new.is_superadmin is distinct from old.is_superadmin)) and (current_user <> 'postgres' or session_user <> 'postgres') then
 raise exception 'Role changes require SQL Editor' using errcode='42501'; end if;
 return new;
end $$;
create trigger admin_role_guard before insert or update on public.profiles for each row execute function public.admin_guard_role();

create table public.admin_audit (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null,
 request_id uuid not null, operation text not null check(operation in ('create','update','delete')),
 target_id uuid not null, details jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), unique(actor_id,request_id)
);
alter table public.admin_audit enable row level security;
revoke all on public.admin_audit from public,anon,authenticated,service_role;
create index admin_audit_actor_time on public.admin_audit(actor_id,created_at desc);
create index admin_votes_user_time on public.caption_votes(user_id,created_at desc);
create index admin_votes_time on public.caption_votes(created_at desc);
create index admin_captions_created on public.captions(created_at desc,id desc);

-- Invoked inside EVERY admin RPC. Lock serializes demotion/deletion with the operation.
create function public.admin_assert() returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
 if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
 perform 1 from public.profiles p join auth.users u on u.id=p.id where p.id=actor and p.is_superadmin is true for share of p,u;
 if not found then raise exception 'Superadmin required' using errcode='42501'; end if;
 return actor;
end $$;
create function public.admin_identity() returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
 actor:=public.admin_assert();
 return (select jsonb_build_object('id',p.id,'first_name',p.first_name,'last_name',p.last_name,'avatar_url',p.avatar_url,'is_superadmin',p.is_superadmin) from public.profiles p where p.id=actor);
end $$;

-- Fixed, typed filters. No dynamic SQL, interpolated identifiers, emails or auth metadata.
create function public.admin_users(q text default '',sort_by text default 'joined',page_number integer default 1)
returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb; total bigint;
begin
 perform public.admin_assert();
 if q is null or sort_by is null or page_number is null or length(q)>100 or page_number not between 1 and 100000 or sort_by not in ('joined','activity','votes','xp') then raise exception 'Invalid filters' using errcode='22023'; end if;
 with votes as(select user_id,count(*) n,max(greatest(created_at,updated_at)) activity from public.caption_votes group by user_id),
 media as(select creator_id,count(*) n,max(updated_at) activity from public.captions group by creator_id),
 xp as(select user_id,sum(amount) n from public.hub_xp_events group by user_id),
 rows as(select p.id,p.first_name,p.last_name,p.avatar_url,p.is_superadmin,u.created_at,
 coalesce(v.n,0) vote_count,coalesce(m.n,0) media_count,coalesce(x.n,0) xp,
 greatest(v.activity,m.activity,u.created_at) last_activity,
 (length(trim(coalesce(p.first_name,'')))>0 and length(trim(coalesce(p.last_name,'')))>0) profile_complete
 from public.profiles p join auth.users u on u.id=p.id left join votes v on v.user_id=p.id left join media m on m.creator_id=p.id left join xp x on x.user_id=p.id
 where q='' or strpos(lower(concat_ws(' ',p.first_name,p.last_name)),lower(q))>0 or p.id::text=q),
 paged as(select * from rows order by
 case when sort_by='joined' then created_at end desc,
 case when sort_by='activity' then last_activity end desc,
 case when sort_by='votes' then vote_count end desc,
 case when sort_by='xp' then xp end desc,id desc limit 20 offset ((page_number-1)::bigint*20))
 select (select count(*) from rows),coalesce((select jsonb_agg(to_jsonb(paged)) from paged),'[]'::jsonb) into total,items;
 return jsonb_build_object('items',items,'total',total,'page',page_number,'page_size',20);
end $$;

create function public.admin_user_detail(target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform public.admin_assert();
 select jsonb_build_object('id',p.id,'first_name',p.first_name,'last_name',p.last_name,'avatar_url',p.avatar_url,'is_superadmin',p.is_superadmin,'created_at',u.created_at,
 'vote_count',(select count(*) from public.caption_votes where user_id=target),
 'media_count',(select count(*) from public.captions where creator_id=target),
 'xp',(select coalesce(sum(amount),0) from public.hub_xp_events where user_id=target),
 'streak',(select current_streak from public.hub_streak(target,(now() at time zone 'UTC')::date)),
 'longest_streak',(select longest_streak from public.hub_streak(target,(now() at time zone 'UTC')::date)),
 'rated_versions',(select count(*) from public.hub_version_ratings where user_id=target),
 'achievements',(select coalesce(jsonb_agg(achievement),'[]'::jsonb) from public.hub_achievements where user_id=target),
 'recent_votes',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from (select v.id,v.caption_id,v.version_id,v.value,v.created_at,v.updated_at,h.caption from public.caption_votes v join public.caption_versions h on h.id=v.version_id where v.user_id=target order by greatest(v.created_at,v.updated_at) desc,v.id desc limit 10) r),
 'media',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from (select id,caption,created_at from public.captions where creator_id=target order by created_at desc,id desc limit 10) r)) into result
 from public.profiles p join auth.users u on u.id=p.id where p.id=target;
 return result;
end $$;

create function public.admin_media(q text default '',sort_by text default 'newest',page_number integer default 1,from_day date default null,to_day date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb; total bigint;
begin
 perform public.admin_assert();
 if q is null or sort_by is null or page_number is null or length(q)>100 or page_number not between 1 and 100000 or sort_by not in ('newest','oldest','score','votes','controversy') or (from_day is not null and to_day<from_day) then raise exception 'Invalid filters' using errcode='22023'; end if;
 with tally as(select version_id,count(*) total_votes,count(*) filter(where value) positive,count(*) filter(where not value) negative from public.caption_votes group by version_id),
 rows as(select c.id,c.creator_id,c.caption,c.model,c.created_at,c.updated_at,c.feed_published_at,c.active_version_id,v.version_number,
 concat_ws(' ',p.first_name,p.last_name) creator_name,coalesce(t.total_votes,0) total_votes,coalesce(t.positive,0) positive,coalesce(t.negative,0) negative,coalesce(t.positive,0)-coalesce(t.negative,0) score
 from public.captions c join public.caption_versions v on v.id=c.active_version_id and v.caption_id=c.id and v.archived_at is null and v.published_at=c.feed_published_at
 left join public.profiles p on p.id=c.creator_id left join tally t on t.version_id=c.active_version_id
 where (q='' or strpos(lower(c.caption),lower(q))>0 or c.id::text=q) and (from_day is null or c.created_at>=from_day::timestamp at time zone 'UTC') and (to_day is null or c.created_at<(to_day+1)::timestamp at time zone 'UTC')),
 paged as(select * from rows order by
 case when sort_by='score' then score end desc,
 case when sort_by='votes' then total_votes end desc,
 case when sort_by='controversy' then least(positive,negative) end desc,
 case when sort_by='oldest' then created_at end asc,
 case when sort_by<>'oldest' then feed_published_at end desc,id desc limit 20 offset ((page_number-1)::bigint*20))
 select (select count(*) from rows),coalesce((select jsonb_agg(to_jsonb(paged)) from paged),'[]'::jsonb) into total,items;
 return jsonb_build_object('items',items,'total',total,'page',page_number,'page_size',20);
end $$;

create function public.admin_media_detail(target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform public.admin_assert();
 select jsonb_build_object('id',c.id,'creator_id',c.creator_id,'creator_name',concat_ws(' ',p.first_name,p.last_name),'caption',c.caption,'model',c.model,'image_path',c.image_path,'created_at',c.created_at,'updated_at',c.updated_at,'feed_published_at',c.feed_published_at,'active_version_id',c.active_version_id,
 'positive',(select count(*) from public.caption_votes where version_id=c.active_version_id and value),
 'negative',(select count(*) from public.caption_votes where version_id=c.active_version_id and not value),
 'generation_prompt',c.generation_prompt,
 'versions',(select jsonb_agg(jsonb_build_object('id',v.id,'version_number',v.version_number,'caption',v.caption,'published_at',v.published_at,'active',v.id=c.active_version_id,'positive',(select count(*) from public.caption_votes where version_id=v.id and value),'negative',(select count(*) from public.caption_votes where version_id=v.id and not value)) order by v.version_number desc) from public.caption_versions v where v.caption_id=c.id)) into result
 from public.captions c left join public.profiles p on p.id=c.creator_id where c.id=target;
 return result;
end $$;

create function public.admin_ratings(q text default '',vote_type text default 'all',sort_by text default 'recent',page_number integer default 1)
returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb; total bigint;
begin
 perform public.admin_assert();
 if q is null or vote_type is null or sort_by is null or page_number is null or length(q)>100 or page_number not between 1 and 100000 or vote_type not in ('all','positive','negative') or sort_by not in ('recent','oldest','updated') then raise exception 'Invalid filters' using errcode='22023'; end if;
 with rows as(select v.id,v.user_id,v.caption_id,v.version_id,v.value,v.created_at,v.updated_at,h.caption,h.version_number,c.active_version_id=v.version_id active,concat_ws(' ',p.first_name,p.last_name) voter_name
 from public.caption_votes v join public.caption_versions h on h.id=v.version_id join public.captions c on c.id=v.caption_id left join public.profiles p on p.id=v.user_id
 where (vote_type='all' or (vote_type='positive' and v.value) or (vote_type='negative' and not v.value))
 and (q='' or strpos(lower(h.caption),lower(q))>0 or strpos(lower(concat_ws(' ',p.first_name,p.last_name)),lower(q))>0 or v.user_id::text=q or v.caption_id::text=q)),
 paged as(select * from rows order by
 case when sort_by='oldest' then created_at end asc,
 case when sort_by='recent' then created_at end desc,
 case when sort_by='updated' then updated_at end desc,id desc limit 20 offset ((page_number-1)::bigint*20))
 select (select count(*) from rows),coalesce((select jsonb_agg(to_jsonb(paged)) from paged),'[]'::jsonb) into total,items;
 return jsonb_build_object('items',items,'total',total,'page',page_number,'page_size',20);
end $$;

create function public.admin_overview(days integer default 30) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; first_day date; today date:=(now() at time zone 'UTC')::date;
begin
 perform public.admin_assert();
 if days is null or days not in (0,7,30,90) then raise exception 'Invalid range' using errcode='22023'; end if;
 if days=0 then
 select least(coalesce(min((created_at at time zone 'UTC')::date),today),today) into first_day from auth.users;
 select least(first_day,coalesce((select min((created_at at time zone 'UTC')::date) from public.captions),today),coalesce((select min((created_at at time zone 'UTC')::date) from public.caption_votes),today)) into first_day;
 else first_day:=today-(days-1); end if;
 with u as(select count(*) total,count(*) filter(where created_at>=now()-interval '7 days') new7,count(*) filter(where created_at>=now()-interval '30 days') new30 from auth.users),
 c as(select count(*) total from public.captions),
 v as(select count(*) total,count(*) filter(where value) positive,count(*) filter(where not value) negative,count(*) filter(where created_at>=now()-interval '24 hours') day_votes,count(*) filter(where created_at>=now()-interval '7 days') week_votes,count(distinct user_id) voters from public.caption_votes),
 repeats as(select count(*) n from (select user_id from public.caption_votes group by user_id having count(distinct (created_at at time zone 'UTC')::date)>1) r),
 user_days as(select (created_at at time zone 'UTC')::date as day,count(*) n from auth.users where created_at>=first_day::timestamp at time zone 'UTC' group by 1),
 vote_days as(select (created_at at time zone 'UTC')::date as day,count(*) n from public.caption_votes where created_at>=first_day::timestamp at time zone 'UTC' group by 1),
 media_days as(select (created_at at time zone 'UTC')::date as day,count(*) n from public.captions where created_at>=first_day::timestamp at time zone 'UTC' group by 1),
 -- All-time uses UTC months to keep chart payload bounded for long histories.
 daily as(select d::date as day,coalesce(ud.n,0) users,coalesce(vd.n,0) votes,coalesce(md.n,0) media from generate_series(first_day::timestamp,today::timestamp,interval '1 day') d left join user_days ud on ud.day=d::date left join vote_days vd on vd.day=d::date left join media_days md on md.day=d::date),
 series as(select case when days=0 then date_trunc('month',day)::date else day end as day,sum(users) users,sum(votes) votes,sum(media) media from daily group by 1 order by 1),
 activity as(select * from (
 select id,'registration' kind,created_at stamp,'New member registered' label from auth.users
 union all select id,'media',created_at,left(caption,120) from public.captions
 union all select id,'vote',greatest(created_at,updated_at),case when value then 'Funny vote recorded' else 'Not funny vote recorded' end from public.caption_votes) a order by stamp desc,id desc limit 12)
 select jsonb_build_object('users',u.total,'new_users_7',u.new7,'new_users_30',u.new30,'media',c.total,'votes',v.total,'positive',v.positive,'negative',v.negative,'votes_24h',v.day_votes,'votes_7d',v.week_votes,'voters',v.voters,
 'participation',case when u.total=0 then 0 else round(100.0*v.voters/u.total,1) end,
 'votes_per_caption',case when c.total=0 then 0 else round(v.total::numeric/c.total,1) end,
 'votes_per_active_user',case when v.voters=0 then 0 else round(v.total::numeric/v.voters,1) end,
 'repeat_voters',repeats.n,
 'series',(select coalesce(jsonb_agg(to_jsonb(series)),'[]'::jsonb) from series),
 'recent',(select coalesce(jsonb_agg(to_jsonb(activity)),'[]'::jsonb) from activity),
 'as_of',now(),'range_days',days,'bucket',case when days=0 then 'month' else 'day' end) into result from u,c,v,repeats;
 return result;
end $$;

-- Mutations create an immutable audit entry in the SAME transaction as content writes.
-- Requests are idempotent; a token cannot be reused with different payloads.
create function public.admin_mutate(operation text,request_token uuid,target uuid default null,content text default null,expected_at timestamptz default null,saved_path text default null,used_model text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; media_owner uuid; previous public.admin_audit%rowtype; c public.captions%rowtype; payload jsonb; result jsonb; new_id uuid; publication timestamptz; next_number integer;
begin
 actor:=public.admin_assert();
 if request_token is null or operation is null or operation not in ('create','update','delete') then raise exception 'Invalid mutation' using errcode='22023'; end if;
 payload:=jsonb_build_object('operation',operation,'target',target,'content',content,'expected_at',expected_at,'saved_path',saved_path,'model',used_model);
 perform pg_advisory_xact_lock(hashtextextended('admin:'||actor::text,0));
 select * into previous from public.admin_audit where actor_id=actor and request_id=request_token;
 if found then
 if previous.details->'request' is distinct from payload then raise exception 'Request token reused' using errcode='22023'; end if;
 return previous.result;
 end if;
 if operation in ('create','update') and (content is null or length(trim(content)) not between 1 and 280) then raise exception 'Invalid caption' using errcode='22023'; end if;
 if operation='create' then
 if used_model is null or length(used_model) not between 1 and 100 or saved_path is null or saved_path not like actor::text||'/admin-'||request_token::text||'-%'
 or not exists(select 1 from storage.objects where bucket_id='caption-images' and name=saved_path and owner_id=actor::text) then raise exception 'Invalid owned image or model' using errcode='22023'; end if;
 insert into public.captions(creator_id,image_path,caption,model,user_prompt,generation_prompt) values(actor,saved_path,trim(content),used_model,'Admin publication','Admin-reviewed caption publication') returning id into new_id;
 result:=jsonb_build_object('id',new_id);
 else
 -- Match owner edit/restore/delete lock order: owner advisory lock BEFORE caption.
 -- Creator identity is immutable; recheck the row after acquiring the lock.
 select creator_id into media_owner from public.captions where id=target;
 if not found then raise exception 'Media not found' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended(media_owner::text,0));
 select * into c from public.captions where id=target for update;
 if not found then raise exception 'Media not found' using errcode='P0002'; end if;
 if expected_at is null or c.updated_at is distinct from expected_at then raise exception 'Revision changed' using errcode='40001'; end if;
 new_id:=c.id;
 if operation='update' then
 if c.caption is distinct from trim(content) then
 publication:=clock_timestamp();
 select max(version_number)+1 into next_number from public.caption_versions where caption_id=c.id;
 update public.caption_versions set archived_at=publication where id=c.active_version_id;
 insert into public.caption_versions(caption_id,version_number,image_path,caption,model,user_prompt,generation_prompt,published_at)
 values(c.id,next_number,c.image_path,trim(content),c.model,c.user_prompt,c.generation_prompt,publication) returning id into target;
 update public.captions set caption=trim(content),active_version_id=target,feed_published_at=publication where id=c.id;
 end if;
 result:=jsonb_build_object('id',c.id);
 else
 -- Trusted-owner helper stays service-only. admin_assert authorized this call.
 -- Admin replay is tracked above; never reuse an external token in the owner's
 -- mutation namespace, where an unrelated edit/delete could already use it.
 result:=public.caption_delete_own(c.creator_id,c.id,gen_random_uuid());
 end if;
 end if;
 insert into public.admin_audit(actor_id,request_id,operation,target_id,details,result)
 values(actor,request_token,operation,new_id,jsonb_build_object('request',payload,'previous',case when c.id is null then null else jsonb_build_object('caption',c.caption,'version_id',c.active_version_id,'creator_id',c.creator_id) end),result);
 return result;
end $$;

-- Remove inherited/default EXECUTE grants on only these newly introduced functions.
do $$ declare f record; g record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_guard_role','admin_assert','admin_identity','admin_users','admin_user_detail','admin_media','admin_media_detail','admin_ratings','admin_overview','admin_mutate') loop
 execute format('alter function %s owner to postgres',f.signature);
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid=f.signature::oid and a.grantee<>p.proowner loop
 execute format('revoke all on function %s from %I cascade',f.signature,g.rolname);
 end loop;
 end loop;
end $$;
grant execute on function public.admin_identity(),public.admin_users(text,text,integer),public.admin_user_detail(uuid),public.admin_media(text,text,integer,date,date),public.admin_media_detail(uuid),public.admin_ratings(text,text,text,integer),public.admin_overview(integer),public.admin_mutate(text,uuid,uuid,text,timestamptz,text,text) to authenticated;
commit;
