-- Opt-in prompt execution. Does not seed, activate, or rewrite catalog records.
begin;
set local search_path=pg_catalog,pg_temp;
select pg_advisory_xact_lock(hashtextextended('humor-runtime-install',0));
do $$ begin
 if current_user<>'postgres' then raise exception 'Install the reviewed prompt runtime as postgres' using errcode='42501';end if;
 if to_regprocedure('public.admin_assert()') is null or to_regclass('public.prompt_chains') is null or to_regprocedure('public.caption_generation_finish(uuid,uuid,text[],text,text,boolean)') is null then raise exception 'Install reviewed Week 7 and draft prerequisites first';end if;
end $$;
do $$ declare t text;begin
 foreach t in array array['hs_runtime_settings','hs_model_adapters','hs_generation_batches','hs_llm_calls','hs_batch_step_models'] loop
  if to_regclass('public.'||t) is not null and not exists(select 1 from pg_class where oid=to_regclass('public.'||t) and relkind='r' and not relforcerowsecurity and relowner='postgres'::regrole and relrowsecurity and obj_description(oid,'pg_class')='Humor prompt execution v1') then raise exception 'Unmanaged runtime object requires review: %',t;end if;
  if exists(select 1 from pg_policy where polrelid=to_regclass('public.'||t)) then raise exception 'Unexpected private runtime RLS policy requires review: %',t;end if;
 end loop;
 if not exists(select 1 from pg_proc where oid='public.admin_assert()'::regprocedure and proowner='postgres'::regrole and prosecdef and proconfig @> array['search_path=""']) then raise exception 'Unexpected admin authorization helper';end if;
end $$;
-- Reapplication follows the same settings-before-catalog lock order as edits/plans.
do $$ begin
 if to_regclass('public.hs_runtime_settings') is not null then
  perform 1 from public.hs_runtime_settings where id for update;
 end if;
end $$;
create table if not exists public.hs_runtime_settings (
 id boolean primary key default true check(id),revision bigint not null default 0 check(revision>=0),
 enforce_mix boolean not null default false,default_model text not null default 'gemini-3.1-flash-lite' check(default_model ~ '^gemini-[a-z0-9.-]+$')
);
insert into public.hs_runtime_settings(id) values(true) on conflict do nothing;
create table if not exists public.hs_model_adapters (
 model_id uuid primary key references public.llm_models(id) on delete cascade,
 adapter text not null default 'gemini' check(adapter='gemini'),
 approved_identifier text not null,approved_provider uuid not null references public.llm_providers(id) on delete restrict,
 approved_temperature numeric not null,approved_max_tokens integer not null
);
-- Old local approvals without configuration evidence must be explicitly reapproved.
alter table public.hs_model_adapters add column if not exists approved_temperature numeric,
 add column if not exists approved_max_tokens integer;
create index if not exists hs_model_adapters_provider on public.hs_model_adapters(approved_provider);
alter table public.prompt_chain_steps add column if not exists execution_role text not null default 'auto'
 check(execution_role in ('auto','image_analysis','ideation','caption_generation','refinement'));
create table if not exists public.hs_generation_batches (
 user_id uuid not null,request_id uuid not null,
 chain_id uuid references public.prompt_chains(id) on delete restrict,
 source_media_id uuid references public.captions(id) on delete set null,
 draft_id uuid references public.caption_drafts(id) on delete set null,
 revision bigint not null,snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 status text not null default 'running' check(status in ('running','completed','failed','timed_out','uncertain','canceled')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 error_category text check(error_category in ('configuration','provider','malformed','timeout','transport','persistence','canceled')),
 primary key(user_id,request_id),
 foreign key(user_id) references auth.users(id) on delete cascade
);
create index if not exists hs_batches_started on public.hs_generation_batches(started_at desc);
create index if not exists hs_batches_media on public.hs_generation_batches(source_media_id);
create index if not exists hs_batches_draft on public.hs_generation_batches(draft_id);
create index if not exists hs_batches_chain on public.hs_generation_batches(chain_id);
create table if not exists public.hs_llm_calls (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,request_id uuid not null,
 step_id uuid references public.prompt_chain_steps(id) on delete restrict,
 step_position integer not null,attempt integer not null check(attempt between 1 and 2),
 model_id uuid not null references public.llm_models(id) on delete restrict,
 model text not null,provider text not null,status text not null default 'running' check(status in ('running','completed','failed','timed_out','uncertain')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 input_tokens integer check(input_tokens>=0),output_tokens integer check(output_tokens>=0),
 content jsonb check(octet_length(content::text)<=32768),error_category text check(error_category in ('provider','malformed','timeout','transport')),
 unique(user_id,request_id,step_position,attempt),
 foreign key(user_id,request_id) references public.hs_generation_batches(user_id,request_id) on delete cascade
);
create index if not exists hs_calls_model on public.hs_llm_calls(model_id);
create index if not exists hs_calls_step on public.hs_llm_calls(step_id);

-- Pin every planned UUID before dispatch, not just models already called.
create table if not exists public.hs_batch_step_models (
 user_id uuid not null,request_id uuid not null,
 step_id uuid not null references public.prompt_chain_steps(id) on delete restrict,
 model_id uuid not null references public.llm_models(id) on delete restrict,
 primary key(user_id,request_id,step_id),
 foreign key(user_id,request_id) references public.hs_generation_batches(user_id,request_id) on delete cascade
);
create index if not exists hs_batch_step_models_step on public.hs_batch_step_models(step_id);
create index if not exists hs_batch_step_models_model on public.hs_batch_step_models(model_id);
-- Repair only references proven by existing recorded snapshots; never invent history.
insert into public.hs_batch_step_models(user_id,request_id,step_id,model_id)
 select b.user_id,b.request_id,(step->>'id')::uuid,(step->>'model_id')::uuid
 from public.hs_generation_batches b cross join lateral jsonb_array_elements(b.snapshot->'steps') step
 on conflict do nothing;


-- Private helper: exact hundredth-percent buckets; ticket's upper bound is exclusive.
create or replace function public.hs_select_chain(ticket integer) returns uuid
language plpgsql security definer set search_path='' as $$
declare selected uuid;
begin
 if ticket is null or ticket not between 0 and 9999 then raise exception 'Invalid selection ticket' using errcode='22023';end if;
 select x.chain_id into selected from (
  select chain_id,allocation,sum(allocation*100) over(order by chain_id rows unbounded preceding) cumulative
  from public.prompt_chain_mix where enabled
 ) x where allocation>0 and cumulative>ticket order by cumulative limit 1;
 if selected is null then raise exception 'No usable chain for ticket' using errcode='22023';end if;
 return selected;
end $$;

create or replace function public.hs_chain_snapshot(target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; step_row record; n integer:=0; matched text[];
begin
 if not exists(select 1 from public.prompt_chains where id=target) then raise exception 'Chain missing' using errcode='22023';end if;
 for step_row in select st.*,m.id resolved_model_id,m.identifier,m.name model_name,m.enabled model_enabled,m.temperature,m.max_tokens,p.identifier provider,p.enabled provider_enabled,a.model_id approved
 from public.prompt_chain_steps st
 left join public.llm_models m on m.id=coalesce(st.model_id,(select id from public.llm_models where identifier=(select default_model from public.hs_runtime_settings where id)))
 left join public.llm_providers p on p.id=m.provider_id
 left join public.hs_model_adapters a on a.model_id=m.id and a.approved_identifier=m.identifier and a.approved_provider=m.provider_id and a.approved_temperature=m.temperature and a.approved_max_tokens=m.max_tokens
 where st.chain_id=target order by st.position loop
  n:=n+1;
  if n>4 or step_row.approved is null or not step_row.model_enabled or not step_row.provider_enabled or (step_row.identifier !~ '^gemini-[a-z0-9.-]+$' or length(step_row.identifier)>100) or step_row.max_tokens not between 128 and 4096 then raise exception 'Each step requires an enabled, approved Gemini model with 128-4096 output tokens; NULL uses the configured default' using errcode='22023';end if;
  for matched in select regexp_matches(step_row.prompt_template,'\{\{([^{}]+)\}\}','g') loop
   if matched[1] not in ('previous','avoid') or (matched[1]='previous' and n=1) then raise exception 'Templates support {{avoid}} and {{previous}} after the first step' using errcode='22023';end if;
  end loop;
  if regexp_replace(step_row.prompt_template,'\{\{([^{}]+)\}\}','','g') ~ '(\{\{|\}\})' then raise exception 'Malformed template variable' using errcode='22023';end if;
 end loop;
 if n=0 then raise exception 'Active chains need 1-4 executable steps' using errcode='22023';end if;
 if (select execution_role from public.prompt_chain_steps where chain_id=target order by position desc limit 1) not in ('auto','caption_generation','refinement') then raise exception 'Final step must generate or refine captions' using errcode='22023';end if;
 select jsonb_build_object('chain_id',c.id,'name',c.name,'description',c.description,'steps',(
 select jsonb_agg(jsonb_build_object('id',s.id,'position',s.position,'role',s.execution_role,'template',s.prompt_template,'model_id',m.id,'model',m.identifier,'provider',p.identifier,'temperature',m.temperature,'max_tokens',m.max_tokens,'default_model',s.model_id is null) order by s.position)
 from public.prompt_chain_steps s join public.llm_models m on m.id=coalesce(s.model_id,(select id from public.llm_models where identifier=(select default_model from public.hs_runtime_settings where id))) join public.llm_providers p on p.id=m.provider_id where s.chain_id=c.id)) into result from public.prompt_chains c where c.id=target;
 return result;
end $$;
create or replace function public.hs_validate_mix() returns void language plpgsql security definer set search_path='' as $$
declare c uuid;begin
 if (select count(*) from public.prompt_chain_mix where enabled) not between 1 and 4
 or (select sum(allocation) from public.prompt_chain_mix where enabled) is distinct from 100::numeric
 or exists(select 1 from public.prompt_chain_mix where enabled and (allocation<0 or allocation<>round(allocation,2))) then raise exception 'Enable 1-4 chains totaling exactly 100%%, at most two decimal places' using errcode='22023';end if;
 for c in select chain_id from public.prompt_chain_mix where enabled loop perform public.hs_chain_snapshot(c);end loop;
end $$;
-- Serialize configuration edits and planning. Validation is opt-in on first atomic save.
create or replace function public.hs_configuration_lock() returns trigger language plpgsql security definer set search_path='' as $$
begin update public.hs_runtime_settings set revision=revision+1 where id;return null;end $$;
create or replace function public.hs_configuration_check() returns trigger language plpgsql security definer set search_path='' as $$
begin if (select enforce_mix from public.hs_runtime_settings where id) then perform public.hs_validate_mix();end if;return null;end $$;
do $$ declare t text;begin
 foreach t in array array['prompt_chains','prompt_chain_steps','prompt_chain_mix','llm_models','llm_providers','hs_model_adapters'] loop
  execute format('drop trigger if exists hs_configuration_lock on public.%I',t);
  execute format('create trigger hs_configuration_lock before insert or update or delete on public.%I for each statement execute function public.hs_configuration_lock()',t);
  execute format('drop trigger if exists hs_configuration_check on public.%I',t);
  execute format('create constraint trigger hs_configuration_check after insert or update or delete on public.%I deferrable initially deferred for each row execute function public.hs_configuration_check()',t);
 end loop;
end $$;
create or replace function public.hs_admin_state() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.admin_assert();
 if not exists(select 1 from public.hs_runtime_settings where id) then raise exception 'Prompt runtime settings missing; restore the reviewed configuration' using errcode='P0002';end if;
 return jsonb_build_object('settings',(select to_jsonb(t) from public.hs_runtime_settings t where id),
 'chains',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('enabled',coalesce(m.enabled,false),'allocation',coalesce(m.allocation,0),'steps',coalesce((select jsonb_agg(to_jsonb(s) order by position) from public.prompt_chain_steps s where chain_id=c.id),'[]'::jsonb)) order by c.name,c.id) from public.prompt_chains c left join public.prompt_chain_mix m on m.chain_id=c.id),'[]'::jsonb),
 'models',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('provider',p.name,'provider_enabled',p.enabled,'approved',a.model_id is not null) order by m.name) from public.llm_models m join public.llm_providers p on p.id=m.provider_id left join public.hs_model_adapters a on a.model_id=m.id and a.approved_identifier=m.identifier and a.approved_provider=m.provider_id and a.approved_temperature=m.temperature and a.approved_max_tokens=m.max_tokens),'[]'::jsonb));
end $$;
create or replace function public.hs_admin_save(operation text,payload jsonb,expected_revision bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare rev bigint;c uuid;s uuid;r jsonb;offset_position integer;pos integer;allowed text[];field text;begin
 perform public.admin_assert();
 select revision into rev from public.hs_runtime_settings where id for update;
 if not found then raise exception 'Prompt runtime settings missing; restore the reviewed configuration' using errcode='P0002';end if;
 if expected_revision is null or rev<>expected_revision then raise exception 'Configuration changed; reload before saving' using errcode='40001';end if;
 if jsonb_typeof(payload) is distinct from 'object' or octet_length(payload::text)>65536 then raise exception 'Invalid payload' using errcode='22023';end if;
 allowed:=case operation when 'mix' then array['allocations'] when 'default_model' then array['identifier'] when 'approve_model' then array['id'] when 'create_chain' then array['name','description'] when 'edit_chain' then array['id','name','description'] when 'delete_chain' then array['id'] when 'create_step' then array['chain_id','template','model_id','role'] when 'edit_step' then array['id','chain_id','template','model_id','role'] when 'delete_step' then array['id','chain_id'] when 'reorder' then array['chain_id','order'] else null end;
 if allowed is null then raise exception 'Unknown operation' using errcode='22023';end if;
 for field in select jsonb_object_keys(payload) loop
  if not(field=any(allowed)) then raise exception 'Unknown field' using errcode='22023';end if;
  if field not in ('allocations','order') and not(field='model_id' and payload->field='null'::jsonb) and jsonb_typeof(payload->field) is distinct from 'string' then raise exception 'Invalid field type' using errcode='22023';end if;
 end loop;
 if operation='mix' then
  if jsonb_typeof(payload->'allocations') is distinct from 'array' or jsonb_array_length(payload->'allocations') not between 1 and 4 then raise exception 'Provide 1-4 allocations' using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(payload->'allocations') x where jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x->'allocation') is distinct from 'number' or jsonb_typeof(x->'chain_id') is distinct from 'string' or (select count(*) from jsonb_object_keys(x))<>2) then raise exception 'Invalid allocations' using errcode='22023';end if;
  if (select count(distinct value->>'chain_id') from jsonb_array_elements(payload->'allocations'))<>jsonb_array_length(payload->'allocations') then raise exception 'Duplicate chain' using errcode='22023';end if;
  update public.prompt_chain_mix set enabled=false,allocation=0,updated_at=clock_timestamp();
  for r in select value from jsonb_array_elements(payload->'allocations') loop
   update public.prompt_chain_mix set enabled=true,allocation=(r->>'allocation')::numeric,updated_at=clock_timestamp() where chain_id=(r->>'chain_id')::uuid;
   if not found then raise exception 'Chain or mix missing' using errcode='22023';end if;
  end loop;
  perform public.hs_validate_mix();
  update public.hs_runtime_settings set enforce_mix=true where id;
 elsif operation='default_model' then
  if not exists(select 1 from public.llm_models m join public.hs_model_adapters a on a.model_id=m.id and a.approved_identifier=m.identifier and a.approved_provider=m.provider_id and a.approved_temperature=m.temperature and a.approved_max_tokens=m.max_tokens where m.identifier=payload->>'identifier') then raise exception 'Approve default model first' using errcode='22023';end if;
  update public.hs_runtime_settings set default_model=payload->>'identifier' where id;
 elsif operation='approve_model' then
  if not exists(select 1 from public.llm_models m join public.llm_providers p on p.id=m.provider_id where m.id=(payload->>'id')::uuid and m.enabled and p.enabled and m.identifier ~ '^gemini-[a-z0-9.-]+$' and length(m.identifier)<=100 and m.max_tokens between 128 and 4096) then raise exception 'Select an enabled image-capable Gemini model with safe token limits' using errcode='22023';end if;
  insert into public.hs_model_adapters(model_id,approved_identifier,approved_provider,approved_temperature,approved_max_tokens) select id,identifier,provider_id,temperature,max_tokens from public.llm_models where id=(payload->>'id')::uuid on conflict(model_id) do update set approved_identifier=excluded.approved_identifier,approved_provider=excluded.approved_provider,approved_temperature=excluded.approved_temperature,approved_max_tokens=excluded.approved_max_tokens;
 elsif operation in ('create_chain','edit_chain') then
  if operation='create_chain' then insert into public.prompt_chains(name,description) values(btrim(payload->>'name'),coalesce(payload->>'description',''));
  else update public.prompt_chains set name=btrim(payload->>'name'),description=coalesce(payload->>'description',''),updated_at=clock_timestamp() where id=(payload->>'id')::uuid;if not found then raise exception 'Chain missing' using errcode='P0002';end if;end if;
 elsif operation='delete_chain' then
  c:=(payload->>'id')::uuid;
  if exists(select 1 from public.hs_generation_batches where chain_id=c) then raise exception 'Historical chain must be retained; disable it in the mix' using errcode='23503';end if;
  delete from public.prompt_chain_steps where chain_id=c;delete from public.prompt_chain_mix where chain_id=c;delete from public.prompt_chains where id=c;
 else
  c:=(payload->>'chain_id')::uuid;
  if not exists(select 1 from public.prompt_chains where id=c) then raise exception 'Chain missing' using errcode='P0002';end if;
  if operation='create_step' then
   if (select count(*) from public.prompt_chain_steps where chain_id=c)>=4 then raise exception 'Maximum four model-driven steps per chain' using errcode='22023';end if;
   insert into public.prompt_chain_steps(chain_id,position,prompt_template,model_id,execution_role) values(c,coalesce((select max(position)+1 from public.prompt_chain_steps where chain_id=c),1),payload->>'template',(payload->>'model_id')::uuid,coalesce(payload->>'role','auto'));
  elsif operation='edit_step' then
   update public.prompt_chain_steps set prompt_template=payload->>'template',model_id=(payload->>'model_id')::uuid,execution_role=coalesce(payload->>'role','auto'),updated_at=clock_timestamp() where id=(payload->>'id')::uuid and chain_id=c;
   if not found then raise exception 'Step missing' using errcode='P0002';end if;
  elsif operation='delete_step' then
   if exists(select 1 from public.hs_generation_batches where snapshot->'steps' @> jsonb_build_array(jsonb_build_object('id',payload->>'id'))) then raise exception 'Historical step must be retained; disable its chain or edit future instructions' using errcode='23503';end if;
   delete from public.prompt_chain_steps where id=(payload->>'id')::uuid and chain_id=c;if not found then raise exception 'Step missing' using errcode='P0002';end if;
  elsif operation='reorder' then
   if jsonb_typeof(payload->'order') is distinct from 'array' or jsonb_array_length(payload->'order')<>(select count(*) from public.prompt_chain_steps where chain_id=c) or (select count(distinct value) from jsonb_array_elements_text(payload->'order'))<>jsonb_array_length(payload->'order') then raise exception 'Provide each step exactly once' using errcode='22023';end if;
   if exists(select 1 from jsonb_array_elements_text(payload->'order') x where not exists(select 1 from public.prompt_chain_steps where chain_id=c and id=x::uuid)) then raise exception 'Invalid step list' using errcode='22023';end if;
   select coalesce(max(position),0)+10 into offset_position from public.prompt_chain_steps where chain_id=c;
   pos:=0;for s in select id from public.prompt_chain_steps where chain_id=c order by position loop update public.prompt_chain_steps set position=offset_position+pos where id=s;pos:=pos+1;end loop;
   pos:=1;for r in select value from jsonb_array_elements(payload->'order') loop update public.prompt_chain_steps set position=pos,updated_at=clock_timestamp() where id=(r#>>'{}')::uuid and chain_id=c;pos:=pos+1;end loop;
  end if;
 end if;
 update public.hs_runtime_settings set revision=revision+1 where id;
 return public.hs_admin_state();
end $$;
-- Service-only planner. Actor must come from the server's verified auth.getUser().
create or replace function public.hs_generation_plan(actor uuid,token uuid,ticket integer,source_media uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid;snapshot jsonb;rev bigint;n integer;day_date date;draft_uuid uuid;begin
 if actor is null or token is null or ticket is null or ticket not between 0 and 9999 then raise exception 'Invalid plan input' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
 select day,draft_id into day_date,draft_uuid from public.caption_generation_requests where user_id=actor and request_id=token and status='pending' for update;
 if not found then raise exception 'Pending reservation required' using errcode='22023';end if;
 if source_media is not null and not exists(select 1 from public.captions where id=source_media and creator_id=actor) then raise exception 'Source media owner mismatch' using errcode='42501';end if;
 if exists(select 1 from public.hs_generation_batches where user_id=actor and request_id=token) then raise exception 'Request already planned; do not dispatch again' using errcode='40001';end if;
 select revision into rev from public.hs_runtime_settings where id for share;
 -- A failed plan still gets a durable batch; no historical attribution is invented.
 begin
  perform public.hs_validate_mix();
  c:=public.hs_select_chain(ticket);
  snapshot:=public.hs_chain_snapshot(c)||jsonb_build_object('mix',(select jsonb_agg(jsonb_build_object('chain_id',m.chain_id,'allocation',m.allocation) order by m.chain_id) from public.prompt_chain_mix m where enabled),'default_model',(select default_model from public.hs_runtime_settings where id));n:=jsonb_array_length(snapshot->'steps');
  update public.caption_generation_days set dispatched=dispatched+n-1 where user_id=actor and day=day_date and dispatched+n-1<=24;
  if not found then raise exception 'Insufficient remaining dispatch allowance for configured steps';end if;
 exception when others then
  insert into public.hs_generation_batches(user_id,request_id,source_media_id,draft_id,revision,snapshot,status,finished_at,error_category) values(actor,token,source_media,draft_uuid,rev,'{}','failed',clock_timestamp(),'configuration');
  -- Complete the original reservation in this SAME transaction. A worker crash
  -- after the plan response cannot strand a known no-dispatch failure as pending.
  perform public.caption_generation_finish(actor,token,null,null,null,false);
  return jsonb_build_object('error','Prompt configuration unavailable; ask an administrator to review the runtime setup.');
 end;
 insert into public.hs_generation_batches(user_id,request_id,chain_id,source_media_id,draft_id,revision,snapshot) values(actor,token,c,source_media,draft_uuid,rev,snapshot);
 insert into public.hs_batch_step_models(user_id,request_id,step_id,model_id)
 select actor,token,(step->>'id')::uuid,(step->>'model_id')::uuid from jsonb_array_elements(snapshot->'steps') step;
 return jsonb_build_object('snapshot',snapshot,'revision',rev);
end $$;
create or replace function public.hs_call_start(actor uuid,token uuid,step_index integer,attempt_number integer) returns uuid language plpgsql security definer set search_path='' as $$
declare config jsonb;result uuid;begin
 perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
 select snapshot->'steps'->step_index into config from public.hs_generation_batches where user_id=actor and request_id=token and status='running' for update;
 if not exists(select 1 from public.caption_generation_requests where user_id=actor and request_id=token and status='pending') then raise exception 'Reservation is no longer pending' using errcode='40001';end if;
 if config is null or step_index is null or step_index<0 or attempt_number is null or attempt_number not between 1 and 2 then raise exception 'Invalid call' using errcode='22023';end if;
 if step_index>0 and not exists(select 1 from public.hs_llm_calls where user_id=actor and request_id=token and step_position=(select (snapshot->'steps'->(step_index-1)->>'position')::integer from public.hs_generation_batches where user_id=actor and request_id=token) and status='completed') then raise exception 'Previous step incomplete' using errcode='22023';end if;
 if attempt_number=2 then
  if not exists(select 1 from public.hs_llm_calls where user_id=actor and request_id=token and step_position=(config->>'position')::integer and attempt=1 and status='failed') then raise exception 'Only known failed calls may retry' using errcode='22023';end if;
  update public.caption_generation_days d set dispatched=dispatched+1 from public.caption_generation_requests r where r.user_id=actor and r.request_id=token and d.user_id=actor and d.day=r.day and d.dispatched<24;
  if not found then raise exception 'Dispatch allowance exhausted' using errcode='22023';end if;
 end if;
 insert into public.hs_llm_calls(user_id,request_id,step_id,step_position,attempt,model_id,model,provider) values(actor,token,(config->>'id')::uuid,(config->>'position')::integer,attempt_number,(config->>'model_id')::uuid,config->>'model',config->>'provider') returning id into result;
 return result;
end $$;
create or replace function public.hs_call_finish(call_id uuid,outcome text,result jsonb,input_count integer,output_count integer,category text) returns void language plpgsql security definer set search_path='' as $$
declare field text; values_array jsonb; item jsonb; observed integer:=0;
begin
 if outcome is null or outcome not in ('completed','failed','timed_out','uncertain') then raise exception 'Invalid call status' using errcode='22023';end if;
 if outcome='completed' then
  if result is null or jsonb_typeof(result) is distinct from 'object' then raise exception 'Completed calls require structured content' using errcode='22023';end if;
  for field,values_array in select key,value from jsonb_each(result) loop
   if field not in ('observations','ideas','captions') or jsonb_typeof(values_array) is distinct from 'array'
    or jsonb_array_length(values_array)>20 then raise exception 'Only bounded structured model output may be retained' using errcode='22023';end if;
   if field='captions' and jsonb_array_length(values_array)<>3 then raise exception 'Caption output requires three strings' using errcode='22023';end if;
   for item in select value from jsonb_array_elements(values_array) loop
    if jsonb_typeof(item) is distinct from 'string' or length(btrim(item#>>'{}')) not between 1 and (case when field='captions' then 280 else 1000 end) then raise exception 'Invalid retained output string' using errcode='22023';end if;
    observed:=observed+1;
   end loop;
  end loop;
  if observed=0 or octet_length(result::text)>32768 or category is not null then raise exception 'Invalid completed model content' using errcode='22023';end if;
 elsif result is not null then raise exception 'Failure telemetry must not retain raw provider payloads' using errcode='22023';end if;
 update public.hs_llm_calls set status=outcome,content=result,input_tokens=input_count,output_tokens=output_count,error_category=category,finished_at=clock_timestamp() where id=call_id and status='running';
 if not found then raise exception 'Call already terminal or missing' using errcode='40001';end if;
end $$;
-- Finish through the existing quota/draft implementation in the SAME transaction.
create or replace function public.hs_generation_finish(actor uuid,token uuid,choices text[] default null,used_model text default null,used_prompt text default null,outcome text default 'failed',category text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare draft jsonb;b public.hs_generation_batches%rowtype;begin
 perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
 select * into b from public.hs_generation_batches where user_id=actor and request_id=token for update;
 if b.user_id is null or outcome is null or outcome not in ('completed','failed','timed_out','uncertain','canceled') then raise exception 'Invalid completion' using errcode='22023';end if;
 if b.status='failed' and b.error_category='configuration' then
  if outcome<>'failed' or choices is not null or category is distinct from 'configuration' then raise exception 'Configuration failure is terminal' using errcode='40001';end if;
  return public.caption_generation_finish(actor,token,null,null,null,false);
 end if;
 if b.status not in ('running','failed') or (b.status='failed' and b.error_category is distinct from 'configuration') then raise exception 'Batch already terminal' using errcode='40001';end if;
 if choices is not null and b.chain_id is null then raise exception 'A valid chain snapshot is required' using errcode='22023';end if;
 if choices is not null and (outcome<>'completed' or exists(select 1 from jsonb_array_elements(b.snapshot->'steps') s where not exists(select 1 from public.hs_llm_calls x where x.user_id=actor and x.request_id=token and x.step_position=(s->>'position')::integer and x.status='completed'))) then raise exception 'Incomplete chain' using errcode='22023';end if;
 if (outcome='completed') is distinct from (choices is not null) then raise exception 'Result/status mismatch' using errcode='22023';end if;
 draft:=public.caption_generation_finish(actor,token,choices,used_model,used_prompt,outcome in ('uncertain','timed_out','canceled'));
 if choices is not null and not exists(select 1 from public.caption_generation_requests where user_id=actor and request_id=token and status='completed') then raise exception 'Reservation expired before completion' using errcode='40001';end if;
 if outcome<>'completed' then
  update public.hs_llm_calls set status=case when outcome='timed_out' then 'timed_out' else 'uncertain' end,
   error_category=case when outcome='timed_out' then 'timeout' else 'transport' end,finished_at=clock_timestamp()
   where user_id=actor and request_id=token and status='running';
 end if;
 update public.hs_generation_batches set status=outcome,finished_at=clock_timestamp(),error_category=category where user_id=actor and request_id=token;
 return draft;
end $$;
create or replace function public.hs_admin_telemetry() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.admin_assert();
 return jsonb_build_object('as_of',clock_timestamp(),'batches',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('chain_name',b.snapshot->>'name','calls',coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at) from public.hs_llm_calls x where x.user_id=b.user_id and x.request_id=b.request_id),'[]'::jsonb)) order by b.started_at desc) from (select * from public.hs_generation_batches order by started_at desc,user_id,request_id limit 20) b),'[]'::jsonb),
 'total',(select count(*) from public.hs_generation_batches),
 'chains',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'allocation',m.allocation,'enabled',m.enabled,'selected',(select count(*) from public.hs_generation_batches where chain_id=c.id),'completed',(select count(*) from public.hs_generation_batches where chain_id=c.id and status='completed'))) from public.prompt_chains c join public.prompt_chain_mix m on m.chain_id=c.id),'[]'::jsonb));
end $$;
create or replace function public.hs_admin_batch(actor uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.admin_assert();
 return (select jsonb_build_object('as_of',clock_timestamp(),'total',1,'chains','[]'::jsonb,'batches',jsonb_build_array(to_jsonb(b)||jsonb_build_object('chain_name',b.snapshot->>'name','calls',coalesce((select jsonb_agg(to_jsonb(x) order by started_at) from public.hs_llm_calls x where x.user_id=b.user_id and x.request_id=b.request_id),'[]'::jsonb)))) from public.hs_generation_batches b where user_id=actor and request_id=token);
end $$;
-- Explicit superadmin reconciliation, only for NEW runtime batches past ten minutes.
create or replace function public.hs_reconcile_batch(actor uuid,token uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.admin_assert();perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
 perform 1 from public.hs_generation_batches where user_id=actor and request_id=token and status='running' and started_at<clock_timestamp()-interval '10 minutes' for update;
 if not found then raise exception 'Only running runtime batches older than ten minutes can be reconciled' using errcode='22023';end if;
 update public.hs_llm_calls set status='uncertain',error_category='timeout',finished_at=clock_timestamp() where user_id=actor and request_id=token and status='running';
 perform public.caption_generation_finish(actor,token,null,null,null,true);
 update public.hs_generation_batches set status='uncertain',error_category='timeout',finished_at=clock_timestamp() where user_id=actor and request_id=token;
end $$;
create or replace function public.hs_batch_attribution_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 if (new.user_id,new.request_id,new.chain_id,new.revision,new.snapshot) is distinct from
    (old.user_id,old.request_id,old.chain_id,old.revision,old.snapshot) then
  raise exception 'Generation attribution snapshots are immutable' using errcode='42501';
 end if;
 return new;
end $$;
drop trigger if exists hs_batch_attribution_immutable on public.hs_generation_batches;
create trigger hs_batch_attribution_immutable before update on public.hs_generation_batches
 for each row execute function public.hs_batch_attribution_immutable();

create or replace function public.hs_runtime_probe() returns jsonb language sql security definer set search_path='' as $$ select jsonb_build_object('protocol',1,'default_model',(select default_model from public.hs_runtime_settings where id)) $$;
-- No API role can read private configuration/telemetry tables directly.
do $$ declare t text;f record;g record;begin
 foreach t in array array['hs_runtime_settings','hs_model_adapters','hs_generation_batches','hs_llm_calls','hs_batch_step_models'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('comment on table public.%I is %L',t,'Humor prompt execution v1');
  for g in select distinct acl.grantee from pg_class c cross join lateral aclexplode(c.relacl) acl where c.oid=to_regclass('public.'||t) and acl.grantee<>c.relowner and acl.grantee<>0 loop execute format('revoke all on public.%I from %I cascade',t,pg_get_userbyid(g.grantee));end loop;
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  -- Table-level REVOKE does not remove column ACLs (service_role bypasses RLS).
  for g in select a.attname,case when acl.grantee=0 then 'public' else quote_ident(pg_get_userbyid(acl.grantee)) end grantee
    from pg_attribute a cross join lateral aclexplode(a.attacl) acl
    where a.attrelid=to_regclass('public.'||t) and acl.grantee<>'postgres'::regrole loop
   execute format('revoke all (%I) on public.%I from %s cascade',g.attname,t,g.grantee);
  end loop;
 end loop;
 for f in select oid,oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('hs_chain_snapshot','hs_validate_mix','hs_configuration_lock','hs_configuration_check','hs_admin_state','hs_admin_save','hs_generation_plan','hs_call_start','hs_call_finish','hs_generation_finish','hs_admin_telemetry','hs_admin_batch','hs_runtime_probe','hs_reconcile_batch','hs_select_chain','hs_batch_attribution_immutable') loop
  execute format('alter function %s owner to postgres',f.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  for g in select distinct acl.grantee from pg_proc p cross join lateral aclexplode(p.proacl) acl where p.oid=f.oid and acl.grantee<>p.proowner and acl.grantee<>0 loop execute format('revoke all on function %s from %I cascade',f.signature,pg_get_userbyid(g.grantee));end loop;
 end loop;
end $$;
grant execute on function public.hs_admin_state(),public.hs_admin_save(text,jsonb,bigint),public.hs_admin_telemetry(),public.hs_admin_batch(uuid,uuid),public.hs_reconcile_batch(uuid,uuid) to authenticated;
grant execute on function public.hs_runtime_probe(),public.hs_generation_plan(uuid,uuid,integer,uuid),public.hs_call_start(uuid,uuid,integer,integer),public.hs_call_finish(uuid,text,jsonb,integer,integer,text),public.hs_generation_finish(uuid,uuid,text[],text,text,text,text) to service_role;
commit;
