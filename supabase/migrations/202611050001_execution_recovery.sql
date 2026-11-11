-- Local review artifact. Apply only with explicit hosted approval, after both pct migrations.
begin;
do $$ begin
 if current_user<>'postgres' then raise exception 'Install as postgres';end if;
 if to_regprocedure('public.pct_progress(uuid,integer,jsonb,text)') is null then raise exception 'Tool journal prerequisite missing';end if;
end $$;
-- Keep the original started_at for history; resumed dispatches get a fresh rate-limit window.
alter table public.pct_runs add column last_dispatch_at timestamptz not null default clock_timestamp();
update public.pct_runs set last_dispatch_at=started_at;
create or replace function public.pct_start(token uuid,target uuid,saved_path text,source_hash text) returns jsonb
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
 if exists(select 1 from public.pct_runs where actor=auth.uid() and status='running' and last_dispatch_at>clock_timestamp()-interval '3 minutes') or (select count(*) from public.pct_runs where actor=auth.uid() and last_dispatch_at>clock_timestamp()-interval '1 hour')>=30 then raise exception 'Execution limit reached; wait before trying again' using errcode='P0001';end if;
 if not exists(select 1 from storage.objects where bucket_id='prompt-chain-inputs' and name=saved_path and owner_id=auth.uid()::text) then raise exception 'Image ownership not verified' using errcode='22023';end if;
 -- Same configuration lock as all catalog mutations: consistent immutable plan.
 perform 1 from public.hs_runtime_settings where id for update;
 s:=public.hs_chain_snapshot(target);
 insert into public.pct_runs(id,actor,chain_id,snapshot,image_path,image_hash) values(token,auth.uid(),target,s,saved_path,source_hash);
 insert into public.pct_run_references select token,(x->>'id')::uuid,(x->>'model_id')::uuid from jsonb_array_elements(s->'steps') x;
 return jsonb_build_object('dispatch',true,'id',token,'snapshot',s);
end $$;
-- Claims serialize dispatch, output checkpoints are idempotent, and the final
-- accepted output commits together with Completed. Never clear earlier outputs.
create or replace function public.pct_progress(token uuid,step_index integer,result jsonb default null,outcome text default null) returns void
language plpgsql security definer set search_path='' as $$
declare r public.pct_runs;n integer;total integer;begin
 perform public.admin_assert();
 select * into r from public.pct_runs where id=token and actor=auth.uid() for update;
 if not found then raise exception 'Execution missing' using errcode='P0002';end if;
 n:=jsonb_array_length(r.outputs);total:=jsonb_array_length(r.snapshot->'steps');
 if outcome='completed' and r.status='completed' and n=total then return;end if;
 if result is not null and step_index>=0 and step_index<n then
  if r.outputs->step_index is distinct from result then raise exception 'Checkpoint conflict' using errcode='40001';end if;
  return;
 end if;
 if r.status<>'running' then raise exception 'Execution already finished' using errcode='40001';end if;
 if outcome is not null then
  if outcome not in ('completed','failed','uncertain') or (outcome='completed' and n<>total) then raise exception 'Invalid completion' using errcode='22023';end if;
  update public.pct_runs set status=outcome,finished_at=clock_timestamp(),error=case when outcome='completed' then null else 'Execution stopped. Inspect the step diagnostics and saved outputs before recovery; an unconfirmed started step cannot be dispatched again.' end where id=token;
 else
  if step_index is distinct from n or step_index>=total then raise exception 'Invalid step order' using errcode='22023';end if;
  if result is null then
   if r.current_step is not null and r.current_step>=n then raise exception 'Step already claimed; outcome unconfirmed' using errcode='55000';end if;
   update public.pct_runs set current_step=step_index where id=token;
  else
   if r.current_step is distinct from step_index or jsonb_typeof(result)<>'object' or octet_length(result::text)>16000 then raise exception 'Invalid step output' using errcode='22023';end if;
   if step_index=total-1 and (jsonb_typeof(result->'captions') is distinct from 'array' or jsonb_array_length(result->'captions')<>5) then raise exception 'Final output requires five captions' using errcode='22023';end if;
   update public.pct_runs set outputs=outputs||jsonb_build_array(result),
    status=case when step_index=total-1 then 'completed' else status end,
    finished_at=case when step_index=total-1 then clock_timestamp() else finished_at end,
    error=null where id=token;
  end if;
 end if;
end $$;

create function public.pct_resume(token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.pct_runs;n integer;total integer;begin
 perform public.admin_assert();
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,83001));
 select * into r from public.pct_runs where id=token and actor=auth.uid() for update;
 if not found then raise exception 'Execution missing' using errcode='P0002';end if;
 n:=jsonb_array_length(r.outputs);total:=jsonb_array_length(r.snapshot->'steps');
 if n=total then
  if jsonb_typeof(r.outputs->(n-1)->'captions') is distinct from 'array' or jsonb_array_length(r.outputs->(n-1)->'captions')<>5 then raise exception 'Invalid saved final captions' using errcode='22023';end if;
  update public.pct_runs set status='completed',error=null,finished_at=case when status='completed' then coalesce(finished_at,clock_timestamp()) else clock_timestamp() end where id=token returning * into r;
  return jsonb_build_object('dispatch',false,'run',to_jsonb(r));
 end if;
 if r.status='running' or (r.current_step is not null and r.current_step>=n) then raise exception 'A started step has no confirmed output; do not redispatch' using errcode='55000';end if;
 if r.status not in ('failed','uncertain') then raise exception 'Execution is not resumable' using errcode='55000';end if;
 if exists(select 1 from public.pct_runs where actor=auth.uid() and id<>token and status='running' and last_dispatch_at>clock_timestamp()-interval '3 minutes') or (select count(*) from public.pct_runs where actor=auth.uid() and last_dispatch_at>clock_timestamp()-interval '1 hour')>=30 then raise exception 'Execution limit reached' using errcode='P0001';end if;
 update public.pct_runs set status='running',error=null,finished_at=null,last_dispatch_at=clock_timestamp() where id=token returning * into r;
 return jsonb_build_object('dispatch',true,'run',to_jsonb(r));
end $$;
revoke all on function public.pct_resume(uuid) from public,anon,authenticated,service_role;
grant execute on function public.pct_resume(uuid) to authenticated;
create function public.pct_stop(token uuid,step_index integer,outcome text,reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.admin_assert();
 if step_index is null or step_index not between 0 and 3 or outcome is null or reason is null or outcome not in ('failed','uncertain') or reason not in ('output_contract_rejected','provider_response_rejected','provider_timeout_or_abort','provider_transport_unconfirmed','journal_write_unconfirmed','deadline_before_dispatch','execution_contract_rejected') then raise exception 'Invalid diagnostic' using errcode='22023';end if;
 perform public.pct_progress(token,0,null,outcome);
 update public.pct_runs set error=format('Step %s: %s. Saved outputs are retained. Use safe recovery; a started step without a saved output must not be repeated.',step_index+1,reason) where id=token and actor=auth.uid();
end $$;
create function public.pct_recovery_ready() returns boolean
language plpgsql security definer set search_path='' as $$ begin perform public.admin_assert();return true;end $$;
revoke all on function public.pct_stop(uuid,integer,text,text),public.pct_recovery_ready() from public,anon,authenticated,service_role;
grant execute on function public.pct_stop(uuid,integer,text,text),public.pct_recovery_ready() to authenticated;
-- CREATE OR REPLACE retains the original pct_start/pct_progress grants.
commit;
