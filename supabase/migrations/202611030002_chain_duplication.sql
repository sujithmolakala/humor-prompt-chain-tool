begin;
create function public.pct_duplicate(target uuid,step_target uuid,expected_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rev bigint;new_id uuid;begin
 perform public.admin_assert();
 select revision into rev from public.hs_runtime_settings where id for update;
 if rev is null or expected_revision is null or rev<>expected_revision then raise exception 'Configuration changed' using errcode='40001';end if;
 if step_target is null then
  insert into public.prompt_chains(name,description) select left(name,190)||' (copy)',description from public.prompt_chains where id=target returning id into new_id;
  if new_id is null then raise exception 'Chain missing' using errcode='P0002';end if;
  insert into public.prompt_chain_steps(chain_id,position,prompt_template,model_id,execution_role) select new_id,position,prompt_template,model_id,execution_role from public.prompt_chain_steps where chain_id=target order by position;
 else
  if (select count(*) from public.prompt_chain_steps where chain_id=target)>=4 then raise exception 'Maximum four steps' using errcode='22023';end if;
  insert into public.prompt_chain_steps(chain_id,position,prompt_template,model_id,execution_role) select target,(select coalesce(max(position),0)+1 from public.prompt_chain_steps where chain_id=target),prompt_template,model_id,execution_role from public.prompt_chain_steps where id=step_target and chain_id=target returning id into new_id;
  if new_id is null then raise exception 'Step missing' using errcode='P0002';end if;
 end if;
 update public.hs_runtime_settings set revision=revision+1 where id;
 return public.hs_admin_state();
end $$;
revoke all on function public.pct_duplicate(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.pct_duplicate(uuid,uuid,bigint) to authenticated;
commit;
