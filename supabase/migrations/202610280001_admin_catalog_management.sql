-- Admin catalog management: private catalogs, checked reads/mutations and image metadata.
-- Pending migration: review hosted schema and approve before applying as postgres.
-- Reapplication verifies the managed schema; existing unrelated catalogs stop for mapping review.
begin;
set local search_path=pg_catalog,pg_temp;
select pg_advisory_xact_lock(hashtextextended('admin-catalog-management-migration',0));

do $$
declare implementation record; required record; relation regclass; n text; signature text;
begin
 if current_user<>'postgres' or session_user<>'postgres' then
  raise exception 'Run catalog migration in a postgres session';
 end if;
 if current_setting('server_version_num')::integer<150000 then
  raise exception 'Catalog security-invoker view requires PostgreSQL 15 or later';
 end if;
 select p.* into implementation from pg_proc p where p.oid=to_regprocedure('public.admin_assert()');
 if not found then raise exception 'Missing prerequisite public.admin_assert()'; end if;
 -- Reviewed admin-panel helper: auth.uid(), existing auth user/profile, true role,
 -- transaction share locks against concurrent deletion/demotion; never replace it here.
 if md5(implementation.prosrc)<>'eb49fcb68b930fca10afd45d5d6c3345'
 or implementation.proowner<>'postgres'::regrole or not implementation.prosecdef
 or implementation.prorettype<>'uuid'::regtype
 or not coalesce('search_path=""'=any(implementation.proconfig),false)
 or exists(select 1 from aclexplode(coalesce(implementation.proacl,acldefault('f',implementation.proowner))) a where a.grantee<>implementation.proowner and a.privilege_type='EXECUTE') then
  raise exception 'admin_assert differs from reviewed definition, ownership, search path or private ACL';
 end if;
 -- Authorization also depends on the flag remaining protected from API writes.
 select p.* into implementation from pg_proc p where p.oid=to_regprocedure('public.admin_guard_role()');
 if not found then raise exception 'Missing superadmin role-write guard'; end if;
 if md5(implementation.prosrc)<>'e1189705ecd249dda933277921cb8160' or implementation.proowner<>'postgres'::regrole or implementation.prosecdef
 or not coalesce('search_path=""'=any(implementation.proconfig),false)
 or not exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('public.profiles') and t.tgname='admin_role_guard' and t.tgfoid=implementation.oid and t.tgtype=23 and t.tgenabled in ('O','A') and t.tgqual is null and t.tgnargs=0 and t.tgattr=''::int2vector) then
  raise exception 'Superadmin role-write guard differs from reviewed implementation';
 end if;
 for required in select * from (values
  ('auth.users','id','uuid'),
  ('auth.users','created_at','timestamp with time zone'),
  ('public.profiles','id','uuid'),
  ('public.profiles','first_name','text'),
  ('public.profiles','last_name','text'),
  ('public.profiles','avatar_url','text'),
  ('public.profiles','is_superadmin','boolean'),
  ('public.captions','id','uuid'),
  ('public.captions','creator_id','uuid'),
  ('public.captions','image_path','text'),
  ('public.captions','caption','text'),
  ('public.captions','model','text'),
  ('public.captions','created_at','timestamp with time zone'),
  ('public.captions','updated_at','timestamp with time zone'),
  ('public.captions','active_version_id','uuid'),
  ('public.caption_drafts','id','uuid'),
  ('public.caption_drafts','user_id','uuid'),
  ('public.caption_drafts','image_hash','text'),
  ('public.caption_drafts','candidates','text[]'),
  ('public.caption_drafts','version','uuid'),
  ('public.caption_drafts','model','text'),
  ('public.caption_drafts','generation_prompt','text'),
  ('public.caption_drafts','finalized_id','uuid'),
  ('public.caption_drafts','expires_at','timestamp with time zone'),
  ('public.caption_generation_requests','user_id','uuid'),
  ('public.caption_generation_requests','request_id','uuid'),
  ('public.caption_generation_requests','draft_id','uuid'),
  ('public.caption_generation_requests','day','date'),
  ('public.caption_generation_requests','status','text'),
  ('public.caption_generation_requests','created_at','timestamp with time zone'),
  ('public.admin_generation_bindings','user_id','uuid'),
  ('public.admin_generation_bindings','request_id','uuid'),
  ('public.admin_generation_bindings','media_id','uuid'),
  ('public.admin_generation_bindings','image_path','text'),
  ('public.admin_generation_bindings','image_hash','text'),
  ('public.caption_versions','id','uuid'),
  ('public.caption_versions','caption_id','uuid')) v(relation_name,column_name,type_name) loop
  relation:=to_regclass(required.relation_name);
  if relation is null or not exists(select 1 from pg_attribute a where a.attrelid=relation and a.attname=required.column_name and not a.attisdropped and format_type(a.atttypid,a.atttypmod)=required.type_name) then
   raise exception 'Missing or incompatible prerequisite %.% (%)',required.relation_name,required.column_name,required.type_name;
  end if;
 end loop;
 -- All cross-user sources remain private; the original policies are never broadened.
 if exists(select 1 from pg_class c where c.oid in ('public.profiles'::regclass,'public.captions'::regclass,'public.caption_versions'::regclass,'public.caption_drafts'::regclass,'public.caption_generation_requests'::regclass,'public.admin_generation_bindings'::regclass) and not c.relrowsecurity) then
  raise exception 'Prerequisite RLS is disabled';
 end if;
 for required in select * from (values
  ('public.profiles','id','auth.users','id','c'),
  ('public.captions','creator_id','auth.users','id','c'),
  ('public.caption_drafts','user_id','auth.users','id','c'),
  ('public.caption_drafts','finalized_id','public.captions','id','n'),
  ('public.caption_generation_requests','user_id','auth.users','id','c'),
  ('public.caption_generation_requests','draft_id','public.caption_drafts','id','c'),
  ('public.admin_generation_bindings','user_id','auth.users','id','c')
 ) v(relation_name,column_name,foreign_relation,foreign_column,delete_action) loop
  if not exists(select 1 from pg_constraint c where c.conrelid=to_regclass(required.relation_name) and c.contype='f' and c.confrelid=to_regclass(required.foreign_relation) and c.convalidated
   and c.conkey=array[(select a.attnum from pg_attribute a where a.attrelid=c.conrelid and a.attname=required.column_name)]::smallint[]
   and c.confkey=array[(select a.attnum from pg_attribute a where a.attrelid=c.confrelid and a.attname=required.foreign_column)]::smallint[]
   and c.confdeltype::text=required.delete_action) then
   raise exception 'Missing reviewed relationship %.% -> %.%',required.relation_name,required.column_name,required.foreign_relation,required.foreign_column;
  end if;
 end loop;
 if not exists(select 1 from pg_constraint where conrelid='public.captions'::regclass and conname='captions_active_version_fk' and contype='f' and confrelid='public.caption_versions'::regclass and condeferrable and condeferred and convalidated)
 or not exists(select 1 from pg_constraint c where c.conrelid='public.caption_generation_requests'::regclass and c.contype='p' and (select array_agg(a.attname::text order by k.ordinality) from unnest(c.conkey) with ordinality k(attnum,ordinality) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)=array['user_id','request_id']) then
  raise exception 'Missing reviewed caption-version or request composite-key relationship';
 end if;
 -- Joins must retain their reviewed uniqueness; missing composite keys can
 -- duplicate or misattribute provenance even when column types still match.
 for required in select * from (values
  ('auth.users',array['id'],'p'),
  ('public.profiles',array['id'],'p'),
  ('public.captions',array['id'],'p'),
  ('public.caption_versions',array['id'],'p'),
  ('public.caption_drafts',array['id'],'p'),
  ('public.caption_drafts',array['user_id','image_hash'],'u'),
  ('public.caption_generation_requests',array['user_id','request_id'],'p'),
  ('public.admin_generation_bindings',array['user_id','request_id'],'p')
 ) v(relation_name,column_names,constraint_type) loop
  if not exists(select 1 from pg_constraint c where c.conrelid=to_regclass(required.relation_name) and c.contype::text=required.constraint_type and c.convalidated
   and (select array_agg(a.attname::text order by k.ordinality) from unnest(c.conkey) with ordinality k(attnum,ordinality) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)=required.column_names) then
   raise exception 'Missing reviewed primary/unique key on % (%)',required.relation_name,required.column_names;
  end if;
 end loop;
 if exists(select 1 from public.caption_generation_requests r join public.caption_drafts d on d.id=r.draft_id where r.user_id<>d.user_id)
 or exists(select 1 from public.caption_drafts d where d.candidates is not null and not exists(select 1 from public.caption_generation_requests r where r.user_id=d.user_id and r.request_id=d.version and r.draft_id=d.id and r.status='completed'))
 or exists(select 1 from public.admin_generation_bindings b join public.caption_generation_requests r on r.user_id=b.user_id and r.request_id=b.request_id join public.caption_drafts d on d.id=r.draft_id where d.user_id<>b.user_id or d.image_hash<>b.image_hash) then
  raise exception 'Generation ownership, saved-response token or media-binding provenance is inconsistent';
 end if;
 foreach n in array array['prompt_chains','llm_providers','llm_models','prompt_chain_steps','prompt_chain_mix','terms','generation_examples','allowed_signup_domains','whitelisted_emails','admin_image_metadata'] loop
  relation:=to_regclass('public.'||n);
  if relation is not null then
   signature:='Admin catalog management v1:'||md5(jsonb_build_object(
 'columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=relation and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid=relation),
 'indexes',(select jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=relation),
 'triggers',(select jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled) order by t.tgname) from pg_trigger t where t.tgrelid=relation and not t.tgisinternal)
 )::text);
   if obj_description(relation,'pg_class') is distinct from signature
   or not exists(select 1 from pg_class c where c.oid=relation and c.relkind='r' and c.relowner='postgres'::regrole and c.relrowsecurity)
   or exists(select 1 from pg_policy where polrelid=relation) then
    raise exception 'Existing public.% requires explicit schema/constraint/ownership mapping review',n;
   end if;
  end if;
 end loop;
 for required in select * from (values
  ('admin_catalog_prompt_chains_created','prompt_chains'),
  ('admin_catalog_llm_providers_created','llm_providers'),
  ('admin_catalog_llm_models_created','llm_models'),
  ('admin_catalog_prompt_chain_steps_created','prompt_chain_steps'),
  ('admin_catalog_prompt_chain_mix_created','prompt_chain_mix'),
  ('admin_catalog_terms_created','terms'),
  ('admin_catalog_generation_examples_created','generation_examples'),
  ('admin_catalog_allowed_signup_domains_created','allowed_signup_domains'),
  ('admin_catalog_whitelisted_emails_created','whitelisted_emails'),
  ('admin_catalog_terms_unique','terms'),
  ('admin_catalog_models_provider','llm_models'),
  ('admin_catalog_steps_model','prompt_chain_steps'),
  ('admin_catalog_examples_model','generation_examples'),
  ('admin_catalog_examples_media','generation_examples')) v(index_name,table_name) loop
  if to_regclass('public.'||required.index_name) is not null and not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.'||required.index_name) and i.indrelid=to_regclass('public.'||required.table_name) and i.indisvalid and i.indisready) then
   raise exception 'Existing catalog index name % requires mapping review',required.index_name;
  end if;
 end loop;
 if to_regclass('public.admin_catalog_rows') is not null and not exists(select 1 from pg_class c where c.oid=to_regclass('public.admin_catalog_rows') and c.relkind='v' and c.relowner='postgres'::regrole and obj_description(c.oid,'pg_class')='Admin catalog management v1') then
  raise exception 'Existing catalog view requires review';
 end if;
 for implementation in select p.* from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_catalog_read','admin_catalog_mutate','admin_user_emails','admin_catalog_initialize_mix') loop
  if implementation.proowner<>'postgres'::regrole or obj_description(implementation.oid,'pg_proc') is distinct from 'Admin catalog management v1'
  or implementation.oid not in (coalesce(to_regprocedure('public.admin_catalog_read(text,text,integer,text,uuid)'),0),coalesce(to_regprocedure('public.admin_catalog_mutate(text,text,jsonb,uuid,timestamptz)'),0),coalesce(to_regprocedure('public.admin_user_emails(uuid[])'),0),coalesce(to_regprocedure('public.admin_catalog_initialize_mix()'),0)) then
   raise exception 'Existing catalog function or overload requires review';
  end if;
 end loop;
end $$;

create table if not exists public.prompt_chains (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(trim(name)) between 1 and 200),
 description text not null default '' check(length(description)<=4000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.prompt_chains enable row level security;
revoke all on public.prompt_chains from public,anon,authenticated,service_role;
create index if not exists admin_catalog_prompt_chains_created on public.prompt_chains(created_at,id);
create table if not exists public.llm_providers (
 id uuid primary key default gen_random_uuid(),
 identifier text not null unique check(identifier ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
 name text not null check(length(trim(name)) between 1 and 200),
 enabled boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.llm_providers enable row level security;
revoke all on public.llm_providers from public,anon,authenticated,service_role;
create index if not exists admin_catalog_llm_providers_created on public.llm_providers(created_at,id);
create table if not exists public.llm_models (
 id uuid primary key default gen_random_uuid(),
 identifier text not null unique check(length(trim(identifier)) between 1 and 200),
 name text not null check(length(trim(name)) between 1 and 200),
 provider_id uuid not null references public.llm_providers(id) on delete restrict,
 enabled boolean not null default true,
 temperature numeric not null default 1 check(temperature between 0 and 2),
 max_tokens integer not null default 1024 check(max_tokens between 1 and 1000000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.llm_models enable row level security;
revoke all on public.llm_models from public,anon,authenticated,service_role;
create index if not exists admin_catalog_llm_models_created on public.llm_models(created_at,id);
create table if not exists public.prompt_chain_steps (
 id uuid primary key default gen_random_uuid(),
 chain_id uuid not null references public.prompt_chains(id) on delete restrict,
 position integer not null check(position>=0),
 prompt_template text not null check(length(prompt_template) between 1 and 12000),
 model_id uuid references public.llm_models(id) on delete restrict,
 unique(chain_id,position),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.prompt_chain_steps enable row level security;
revoke all on public.prompt_chain_steps from public,anon,authenticated,service_role;
create index if not exists admin_catalog_prompt_chain_steps_created on public.prompt_chain_steps(created_at,id);
create table if not exists public.prompt_chain_mix (
 id uuid primary key default gen_random_uuid(),
 chain_id uuid not null unique references public.prompt_chains(id) on delete restrict,
 allocation numeric not null default 0 check(allocation>=0 and allocation<=1000000),
 enabled boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.prompt_chain_mix enable row level security;
revoke all on public.prompt_chain_mix from public,anon,authenticated,service_role;
create index if not exists admin_catalog_prompt_chain_mix_created on public.prompt_chain_mix(created_at,id);
create table if not exists public.terms (
 id uuid primary key default gen_random_uuid(),
 term text not null check(length(trim(term)) between 1 and 200),
 definition text not null check(length(trim(definition)) between 1 and 4000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.terms enable row level security;
revoke all on public.terms from public,anon,authenticated,service_role;
create index if not exists admin_catalog_terms_created on public.terms(created_at,id);
create table if not exists public.generation_examples (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(trim(name)) between 1 and 200),
 prompt text not null check(length(trim(prompt)) between 1 and 4000),
 response text not null check(length(trim(response)) between 1 and 12000),
 model_id uuid references public.llm_models(id) on delete restrict,
 media_id uuid references public.captions(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.generation_examples enable row level security;
revoke all on public.generation_examples from public,anon,authenticated,service_role;
create index if not exists admin_catalog_generation_examples_created on public.generation_examples(created_at,id);
create table if not exists public.allowed_signup_domains (
 id uuid primary key default gen_random_uuid(),
 domain text not null unique check(domain=lower(trim(domain)) and length(domain)<=253 and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.allowed_signup_domains enable row level security;
revoke all on public.allowed_signup_domains from public,anon,authenticated,service_role;
create index if not exists admin_catalog_allowed_signup_domains_created on public.allowed_signup_domains(created_at,id);
create table if not exists public.whitelisted_emails (
 id uuid primary key default gen_random_uuid(),
 email text not null unique check(email=lower(trim(email)) and length(email)<=254 and email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.whitelisted_emails enable row level security;
revoke all on public.whitelisted_emails from public,anon,authenticated,service_role;
create index if not exists admin_catalog_whitelisted_emails_created on public.whitelisted_emails(created_at,id);
create table if not exists public.admin_image_metadata (
 id uuid primary key references public.captions(id) on delete cascade,
 label text not null default '' check(length(label)<=200),
 alt_text text not null default '' check(length(alt_text)<=2000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.admin_image_metadata enable row level security;
revoke all on public.admin_image_metadata from public,anon,authenticated,service_role;
create unique index if not exists admin_catalog_terms_unique on public.terms(lower(trim(term)));
create index if not exists admin_catalog_models_provider on public.llm_models(provider_id);
create index if not exists admin_catalog_steps_model on public.prompt_chain_steps(model_id);
create index if not exists admin_catalog_examples_model on public.generation_examples(model_id);
create index if not exists admin_catalog_examples_media on public.generation_examples(media_id);

-- One inactive configuration per real chain. This is structural initialization,
-- not a routing policy, fake chain seed, or a new authenticated INSERT permission.
create or replace function public.admin_catalog_initialize_mix() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.prompt_chain_mix(chain_id,allocation,enabled) values(new.id,0,false)
 on conflict(chain_id) do nothing;
 return new;
end $$;
alter function public.admin_catalog_initialize_mix() owner to postgres;
drop trigger if exists admin_catalog_chain_mix_initialize on public.prompt_chains;
create trigger admin_catalog_chain_mix_initialize after insert on public.prompt_chains
for each row execute function public.admin_catalog_initialize_mix();
insert into public.prompt_chain_mix(chain_id,allocation,enabled)
select id,0,false from public.prompt_chains on conflict(chain_id) do nothing;

-- SECURITY INVOKER checks base-table privileges as the current user. Checked
-- SECURITY DEFINER RPCs run as postgres after admin_assert(); direct API readers
-- have neither view nor base-table grants. Explicit projections prevent new
-- secret columns from being exposed automatically. The barrier is extra defense,
-- not an authorization policy. Do not grant this view to API roles.
create or replace view public.admin_catalog_rows with (security_invoker=true,security_barrier=true) as
select 'prompt-chains'::text resource,t.id::text key,jsonb_build_object('id',t.id,'name',t.name,'description',t.description,'created_at',t.created_at,'updated_at',t.updated_at) value from public.prompt_chains t
union all
select 'prompt-chain-steps'::text resource,t.id::text key,jsonb_build_object('id',t.id,'chain_id',t.chain_id,'position',t.position,'prompt_template',t.prompt_template,'model_id',t.model_id,'created_at',t.created_at,'updated_at',t.updated_at) value from public.prompt_chain_steps t
union all
select 'prompt-chain-mix'::text resource,t.id::text key,jsonb_build_object('id',t.id,'chain_id',t.chain_id,'allocation',t.allocation,'enabled',t.enabled,'created_at',t.created_at,'updated_at',t.updated_at) value from public.prompt_chain_mix t
union all
select 'terms'::text resource,t.id::text key,jsonb_build_object('id',t.id,'term',t.term,'definition',t.definition,'created_at',t.created_at,'updated_at',t.updated_at) value from public.terms t
union all
select 'examples'::text resource,t.id::text key,jsonb_build_object('id',t.id,'name',t.name,'prompt',t.prompt,'response',t.response,'model_id',t.model_id,'media_id',t.media_id,'created_at',t.created_at,'updated_at',t.updated_at) value from public.generation_examples t
union all
select 'models'::text resource,t.id::text key,jsonb_build_object('id',t.id,'identifier',t.identifier,'name',t.name,'provider_id',t.provider_id,'enabled',t.enabled,'temperature',t.temperature,'max_tokens',t.max_tokens,'created_at',t.created_at,'updated_at',t.updated_at) value from public.llm_models t
union all
select 'providers'::text resource,t.id::text key,jsonb_build_object('id',t.id,'identifier',t.identifier,'name',t.name,'enabled',t.enabled,'created_at',t.created_at,'updated_at',t.updated_at) value from public.llm_providers t
union all
select 'signup-domains'::text resource,t.id::text key,jsonb_build_object('id',t.id,'domain',t.domain,'created_at',t.created_at,'updated_at',t.updated_at) value from public.allowed_signup_domains t
union all
select 'whitelisted-emails'::text resource,t.id::text key,jsonb_build_object('id',t.id,'email',t.email,'created_at',t.created_at,'updated_at',t.updated_at) value from public.whitelisted_emails t
union all
select 'images', c.id::text, jsonb_build_object('id',c.id,'media_id',c.id,'image_path',c.image_path,'caption',c.caption,'label',coalesce(m.label,''),'alt_text',coalesce(m.alt_text,''),'created_at',c.created_at,'updated_at',greatest(m.updated_at,c.updated_at))
from public.captions c left join public.admin_image_metadata m on m.id=c.id
union all
-- A draft is an overwritten cache. Only its exact completed version token can
-- attribute retained model output to a request; never backfill older requests
-- with the newest model. Bindings identify regeneration source media separately
-- from the draft's current finalized media (which is not a request outcome).
select 'generation-requests',r.user_id::text||':'||r.request_id::text,
jsonb_build_object('id',r.request_id,'user_id',r.user_id,'draft_id',r.draft_id,'day',r.day,'status',r.status,'created_at',r.created_at,
 'model',case when d.version=r.request_id and r.status='completed' and d.candidates is not null then d.model end,
 'retained_response_key',case when d.version=r.request_id and r.status='completed' and d.candidates is not null then d.id end,
 'source_media_id',b.media_id,'source_image_path',b.image_path,'draft_finalized_media_id',d.finalized_id)
from public.caption_generation_requests r
join public.caption_drafts d on d.id=r.draft_id and d.user_id=r.user_id
left join public.admin_generation_bindings b on b.user_id=r.user_id and b.request_id=r.request_id and b.image_hash=d.image_hash
union all
select 'responses',d.id::text,
jsonb_build_object('id',d.id,'draft_id',d.id,'content_kind','latest_draft_candidates','user_id',d.user_id,'model',d.model,'generation_prompt',d.generation_prompt,
 'candidates',d.candidates,'response_request_id',r.request_id,'request_key',r.user_id::text||':'||r.request_id::text,
 'request_created_at',r.created_at,'request_status',r.status,'source_media_id',b.media_id,
 'draft_finalized_media_id',d.finalized_id,'expires_at',d.expires_at,'expired',d.expires_at<=now())
from public.caption_drafts d
join public.caption_generation_requests r on r.user_id=d.user_id and r.request_id=d.version and r.draft_id=d.id and r.status='completed'
left join public.admin_generation_bindings b on b.user_id=r.user_id and b.request_id=r.request_id and b.image_hash=d.image_hash
where d.candidates is not null;
alter view public.admin_catalog_rows owner to postgres;
comment on view public.admin_catalog_rows is 'Admin catalog management v1';

create or replace function public.admin_catalog_read(resource_name text, q text default '', page_number integer default 1, record_key text default null, chain_filter uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform public.admin_assert();
 if resource_name is null or resource_name not in ('images','prompt-chains','prompt-chain-steps','prompt-chain-mix','terms','examples','models','providers','signup-domains','whitelisted-emails','generation-requests','responses') or q is null or length(q)>100 or page_number is null or page_number not between 1 and 100000 or (record_key is not null and length(record_key)>80) then raise exception 'Invalid filters' using errcode='22023'; end if;
 with rows as(select key,value from public.admin_catalog_rows where resource=resource_name and (record_key is null or key=record_key) and (q='' or strpos(lower(value::text),lower(q))>0) and (chain_filter is null or value->>'chain_id'=chain_filter::text)),
 paged as(select *,row_number() over(order by case when resource_name='prompt-chain-steps' then value->>'chain_id' end,case when resource_name='prompt-chain-steps' then (value->>'position')::integer end,coalesce(value->>'created_at',value->>'request_created_at')::timestamptz desc,key) ordinal from rows order by ordinal limit 20 offset ((page_number-1)::bigint*20))
 select jsonb_build_object('items',coalesce((select jsonb_agg(value||jsonb_build_object('_key',key) order by ordinal) from paged),'[]'::jsonb),'total',(select count(*) from rows),'page',page_number,'page_size',20) into result;
 return result;
end $$;
create or replace function public.admin_catalog_mutate(resource_name text, operation text, payload jsonb default '{}'::jsonb, target uuid default null, expected_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare relation_name text; fields text[]; cols text; vals text; assignments text; result jsonb; previous jsonb; field_name text; field_type text; nullable_fields text[]; uuid_fields text[];
begin
 perform public.admin_assert();
 case resource_name
 when 'images' then relation_name:='admin_image_metadata'; fields:=array['label','alt_text'];
 when 'terms' then relation_name:='terms'; fields:=array['term','definition'];
 when 'examples' then relation_name:='generation_examples'; fields:=array['name','prompt','response','model_id','media_id'];
 when 'models' then relation_name:='llm_models'; fields:=array['identifier','name','provider_id','enabled','temperature','max_tokens'];
 when 'providers' then relation_name:='llm_providers'; fields:=array['identifier','name','enabled'];
 when 'signup-domains' then relation_name:='allowed_signup_domains'; fields:=array['domain'];
 when 'whitelisted-emails' then relation_name:='whitelisted_emails'; fields:=array['email'];
 when 'prompt-chain-mix' then relation_name:='prompt_chain_mix'; fields:=array['chain_id','allocation','enabled'];
 else raise exception 'Read only or unknown resource' using errcode='42501'; end case;
 if operation not in ('create','update','delete') or operation is null or (resource_name in ('images','prompt-chain-mix') and operation<>'update') then raise exception 'Operation not allowed' using errcode='42501'; end if;
 if payload is null or jsonb_typeof(payload)<>'object' or octet_length(payload::text)>30000 then raise exception 'Object payload required' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(payload) k where not(k=any(fields))) then raise exception 'Invalid fields' using errcode='22023'; end if;
 -- Validate JSON types before record conversion: jsonb_populate_record otherwise
 -- accepts numbers as text, string booleans and NULLs that can defeat comparisons.
 nullable_fields:=case when resource_name='examples' then array['model_id','media_id'] else array[]::text[] end;
 uuid_fields:=array['model_id','media_id','provider_id','chain_id'];
 for field_name in select jsonb_object_keys(payload) loop
  field_type:=jsonb_typeof(payload->field_name);
  if field_type='null' and field_name=any(nullable_fields) then continue; end if;
  if field_name='enabled' then
   if field_type<>'boolean' then raise exception 'Boolean required' using errcode='22023'; end if;
  elsif field_name in ('temperature','max_tokens','allocation') then
   if field_type<>'number' then raise exception 'Number required' using errcode='22023'; end if;
  else
   if field_type<>'string' then raise exception 'String required' using errcode='22023'; end if;
   if field_name=any(uuid_fields) and (payload->>field_name)!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    raise exception 'UUID required' using errcode='22023';
   end if;
   payload:=jsonb_set(payload,array[field_name],to_jsonb(trim(payload->>field_name)));
  end if;
 end loop;
 if operation='create' then
  if target is not null or expected_at is not null then raise exception 'Create cannot target an existing record' using errcode='22023'; end if;
 else
  if target is null or expected_at is null or not isfinite(expected_at) then raise exception 'Record and finite revision required' using errcode='22023'; end if;
 end if;
 if operation='delete' and payload<>'{}'::jsonb then raise exception 'Delete cannot contain changes' using errcode='22023'; end if;
 if resource_name='signup-domains' and payload ? 'domain' then payload:=jsonb_set(payload,'{domain}',to_jsonb(lower(payload->>'domain'))); end if;
 if resource_name='whitelisted-emails' and payload ? 'email' then payload:=jsonb_set(payload,'{email}',to_jsonb(lower(payload->>'email'))); end if;
 if resource_name='images' then
  if operation is distinct from 'update' then raise exception 'Use existing media publication/deletion workflow' using errcode='42501'; end if;
  if not(payload ? 'label' and payload ? 'alt_text') then raise exception 'Both image fields required' using errcode='22023'; end if;
  perform 1 from public.captions where id=target for update;
  if not found then raise exception 'Image not found' using errcode='P0002'; end if;
  select value into previous from public.admin_catalog_rows where resource='images' and key=target::text;
  if expected_at is null or (previous->>'updated_at')::timestamptz is distinct from expected_at then raise exception 'Record changed' using errcode='40001'; end if;
  insert into public.admin_image_metadata(id,label,alt_text,updated_at) values(target,payload->>'label',payload->>'alt_text',greatest(clock_timestamp(),expected_at+interval '1 microsecond'))
  on conflict(id) do update set label=excluded.label,alt_text=excluded.alt_text,updated_at=excluded.updated_at;
  return (select value from public.admin_catalog_rows where resource='images' and key=target::text);
 end if;
 if operation<>'create' then
  execute format('select to_jsonb(t) from public.%I t where id=$1 for update',relation_name) into previous using target;
  if previous is null then raise exception 'Record not found' using errcode='P0002'; end if;
  if expected_at is null or (previous->>'updated_at')::timestamptz is distinct from expected_at then raise exception 'Record changed' using errcode='40001'; end if;
 end if;
 if operation='delete' then
  execute format('delete from public.%I where id=$1 returning to_jsonb(%I.*)',relation_name,relation_name) into result using target;
 else
  if operation='create' then
   if (select count(*) from jsonb_object_keys(payload))<>cardinality(fields) then raise exception 'All fields required' using errcode='22023'; end if;
  else
   if payload='{}'::jsonb then raise exception 'Fields required' using errcode='22023'; end if;
   if resource_name='prompt-chain-mix' and payload ? 'chain_id' and (payload->>'chain_id')::uuid is distinct from (previous->>'chain_id')::uuid then raise exception 'Chain cannot change' using errcode='22023'; end if;
  end if;
  select string_agg(format('%I',k),',' order by k),string_agg(format('r.%I',k),',' order by k),string_agg(format('%I=r.%I',k,k),',' order by k) into cols,vals,assignments from jsonb_object_keys(payload) k;
  if operation='create' then
   execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',relation_name,cols,vals,relation_name,relation_name) into result using payload;
  else
   execute format('update public.%I t set %s,updated_at=greatest(clock_timestamp(),t.updated_at+interval ''1 microsecond'') from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 returning to_jsonb(t)',relation_name,assignments,relation_name) into result using payload,target;
  end if;
 end if;
 return (select jsonb_object_agg(k,v) from jsonb_each(result) e(k,v) where k=any(fields||array['id','created_at','updated_at']));
end $$;
-- Email uses a JSON projection so pre-existing schemas without an email column still work.
create or replace function public.admin_user_emails(user_ids uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.admin_assert();
 if user_ids is null or cardinality(user_ids)>20 then raise exception 'Invalid IDs' using errcode='22023'; end if;
 return (select coalesce(jsonb_object_agg(u.id,coalesce(to_jsonb(u)->>'email',to_jsonb(p)->>'email')),'{}'::jsonb) from auth.users u left join public.profiles p on p.id=u.id where u.id=any(user_ids));
end $$;

-- Pin ownership and clear every non-owner ACL, including inherited default
-- grants to custom roles and column grants. Scope is these managed objects only.
do $$ declare f record; g record; n text; relation regclass; signature text; begin
 foreach n in array array['prompt_chains','llm_providers','llm_models','prompt_chain_steps','prompt_chain_mix','terms','generation_examples','allowed_signup_domains','whitelisted_emails','admin_image_metadata','admin_catalog_rows'] loop
  relation:=to_regclass('public.'||n);
  execute format('alter %s public.%I owner to postgres',case when n='admin_catalog_rows' then 'view' else 'table' end,n);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',n);
  for g in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee where c.oid=relation and a.grantee<>c.relowner loop
   execute format('revoke all on public.%I from %I cascade',n,g.rolname);
  end loop;
  for g in select a.attname,case when acl.grantee=0 then 'public' else quote_ident(r.rolname) end grantee from pg_attribute a cross join lateral aclexplode(a.attacl) acl left join pg_roles r on r.oid=acl.grantee where a.attrelid=relation and acl.grantee<>'postgres'::regrole loop
   execute format('revoke all (%I) on public.%I from %s cascade',g.attname,n,g.grantee);
  end loop;
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_catalog_read','admin_catalog_mutate','admin_user_emails','admin_catalog_initialize_mix') loop
  execute format('alter function %s owner to postgres',f.signature);
  execute format('comment on function %s is %L',f.signature,'Admin catalog management v1');
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid=f.signature::oid and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %I cascade',f.signature,g.rolname);
  end loop;
 end loop;
 -- Remember the reviewed managed shape so IF NOT EXISTS cannot silently accept
 -- removed constraints/indexes, changed columns, or replacement triggers on rerun.
 foreach n in array array['prompt_chains','llm_providers','llm_models','prompt_chain_steps','prompt_chain_mix','terms','generation_examples','allowed_signup_domains','whitelisted_emails','admin_image_metadata'] loop
  relation:=to_regclass('public.'||n);
  signature:='Admin catalog management v1:'||md5(jsonb_build_object(
 'columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=relation and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid=relation),
 'indexes',(select jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=relation),
 'triggers',(select jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled) order by t.tgname) from pg_trigger t where t.tgrelid=relation and not t.tgisinternal)
 )::text);
  execute format('comment on table public.%I is %L',n,signature);
 end loop;
end $$;
grant execute on function public.admin_catalog_read(text,text,integer,text,uuid),public.admin_catalog_mutate(text,text,jsonb,uuid,timestamptz),public.admin_user_emails(uuid[]) to authenticated;
commit;
