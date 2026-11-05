-- NEW TOOL ONLY. Review and obtain approval before hosted application.
-- Requires existing admin catalog + 202611010001_prompt_execution.sql.
begin;
do $$ begin
 if session_user <> 'postgres' then raise exception 'Install as postgres'; end if;
 if to_regprocedure('public.hs_chain_snapshot(uuid)') is null then raise exception 'Prompt runtime prerequisite missing'; end if;
end $$;
create table public.pct_runs (
 id uuid primary key,
 actor uuid not null references auth.users(id) on delete restrict,
 chain_id uuid not null references public.prompt_chains(id) on delete restrict,
 snapshot jsonb not null,
 image_path text not null,
 image_hash text not null,
 status text not null default 'running' check(status in ('running','completed','failed','uncertain')),
 outputs jsonb not null default '[]',
 current_step integer,
 error text,
 started_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz
);
create index pct_runs_chain_date on public.pct_runs(chain_id,started_at desc);
create index pct_runs_actor_date on public.pct_runs(actor,started_at desc);
create table public.pct_run_references (
 run_id uuid not null references public.pct_runs(id) on delete restrict,
 step_id uuid not null references public.prompt_chain_steps(id) on delete restrict,
 model_id uuid not null references public.llm_models(id) on delete restrict,
 primary key(run_id,step_id)
);
alter table public.pct_runs enable row level security;
alter table public.pct_run_references enable row level security;
revoke all on public.pct_runs,public.pct_run_references from public,anon,authenticated,service_role;
create function public.pct_start(token uuid,target uuid,saved_path text,source_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s jsonb; existing public.pct_runs;begin
 perform public.admin_assert();
 -- Serialize reservation/rate limit per superadmin, across independent requests.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,83001));
 select * into existing from public.pct_runs where id=token;
 if found then
  if existing.actor<>auth.uid() or existing.chain_id<>target or existing.image_hash<>source_hash then raise exception 'Request identity conflict' using errcode='40001';end if;
  return jsonb_build_object('dispatch',false,'id',existing.id,'status',existing.status);
 end if;
 if saved_path is distinct from auth.uid()::text||'/'||token::text||'-'||source_hash||'.webp' or source_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid image identity' using errcode='22023';end if;
 if exists(select 1 from public.pct_runs where actor=auth.uid() and status='running' and started_at>clock_timestamp()-interval '3 minutes') or (select count(*) from public.pct_runs where actor=auth.uid() and started_at>clock_timestamp()-interval '1 hour')>=30 then raise exception 'Execution limit reached; wait before trying again' using errcode='P0001';end if;
 if not exists(select 1 from storage.objects where bucket_id='prompt-chain-inputs' and name=saved_path and owner_id=auth.uid()::text) then raise exception 'Image ownership not verified' using errcode='22023';end if;
 -- Same configuration lock as all catalog mutations: consistent immutable plan.
 perform 1 from public.hs_runtime_settings where id for update;
 s:=public.hs_chain_snapshot(target);
 insert into public.pct_runs(id,actor,chain_id,snapshot,image_path,image_hash) values(token,auth.uid(),target,s,saved_path,source_hash);
 insert into public.pct_run_references select token,(x->>'id')::uuid,(x->>'model_id')::uuid from jsonb_array_elements(s->'steps') x;
 return jsonb_build_object('dispatch',true,'id',token,'snapshot',s);
end $$;
create function public.pct_progress(token uuid,step_index integer,result jsonb default null,outcome text default null) returns void
language plpgsql security definer set search_path='' as $$
declare r public.pct_runs;n integer;begin
 perform public.admin_assert();
 select * into r from public.pct_runs where id=token and actor=auth.uid() for update;
 if not found then raise exception 'Execution missing' using errcode='P0002';end if;
 if r.status<>'running' then raise exception 'Execution already finished' using errcode='40001';end if;
 n:=jsonb_array_length(r.outputs);
 if outcome is not null then
  if outcome not in ('completed','failed','uncertain') or (outcome='completed' and n<>jsonb_array_length(r.snapshot->'steps')) then raise exception 'Invalid completion' using errcode='22023';end if;
  update public.pct_runs set status=outcome,finished_at=clock_timestamp(),error=case when outcome='completed' then null else 'Execution interrupted. Inspect completed steps before starting a new billable run.' end where id=token;
 else
  if step_index is distinct from n or step_index>=jsonb_array_length(r.snapshot->'steps') then raise exception 'Invalid step order' using errcode='22023';end if;
  if result is not null and (jsonb_typeof(result)<>'object' or octet_length(result::text)>16000) then raise exception 'Invalid step output' using errcode='22023';end if;
  update public.pct_runs set current_step=step_index,outputs=case when result is null then outputs else outputs||jsonb_build_array(result) end where id=token;
 end if;
end $$;
create function public.pct_history(target uuid default null,page_number integer default 1,run_token uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.admin_assert();
 if page_number is null or page_number<1 or page_number>100000 then raise exception 'Invalid page' using errcode='22023';end if;
 return jsonb_build_object('total',(select count(*) from public.pct_runs where (target is null or chain_id=target) and (run_token is null or id=run_token)),
 'runs',coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc,r.id) from (select * from public.pct_runs where (target is null or chain_id=target) and (run_token is null or id=run_token) order by started_at desc,id limit 20 offset (page_number-1)*20) r),'[]'::jsonb),
 'stats',(select jsonb_build_object('total',count(*),'completed',count(*) filter(where status='completed'),'failed',count(*) filter(where status='failed'),'uncertain',count(*) filter(where status='uncertain')) from public.pct_runs));
end $$;
-- Private input images use Supabase Storage; no public URL or service key.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('prompt-chain-inputs','prompt-chain-inputs',false,3145728,array['image/webp']);
-- Public restrictive policies are planned for anonymous avatar requests too.
-- A direct profiles subquery requires profile SELECT privileges even when the
-- bucket predicate is true. Expose only the current caller's role, never rows.
create function public.pct_is_superadmin() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and is_superadmin is true);
$$;
revoke all on function public.pct_is_superadmin() from public,anon,authenticated,service_role;
grant execute on function public.pct_is_superadmin() to anon,authenticated;
create policy pct_input_insert on storage.objects for insert to authenticated with check(bucket_id='prompt-chain-inputs' and (storage.foldername(name))[1]=auth.uid()::text and public.pct_is_superadmin());
create policy pct_input_select on storage.objects for select to authenticated using(bucket_id='prompt-chain-inputs' and public.pct_is_superadmin());
-- Restrictive fences prevent legacy broad policies from exposing this new bucket.
create policy pct_input_read_fence on storage.objects as restrictive for select to public using(bucket_id<>'prompt-chain-inputs' or (auth.uid() is not null and public.pct_is_superadmin()));
create policy pct_input_write_fence on storage.objects as restrictive for insert to public with check(bucket_id<>'prompt-chain-inputs' or ((storage.foldername(name))[1]=auth.uid()::text and owner_id=auth.uid()::text and public.pct_is_superadmin()));
create policy pct_input_update_fence on storage.objects as restrictive for update to public using(bucket_id<>'prompt-chain-inputs') with check(bucket_id<>'prompt-chain-inputs');
create policy pct_input_delete_fence on storage.objects as restrictive for delete to public using(bucket_id<>'prompt-chain-inputs');

revoke all on function public.pct_start(uuid,uuid,text,text),public.pct_progress(uuid,integer,jsonb,text),public.pct_history(uuid,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.pct_start(uuid,uuid,text,text),public.pct_progress(uuid,integer,jsonb,text),public.pct_history(uuid,integer,uuid) to authenticated;
commit;
