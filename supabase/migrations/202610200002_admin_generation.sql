-- PENDING REVIEW. Optional Gemini suggestions use existing quotas and request tombstones.
begin;
do $$ begin if current_user<>'postgres' then raise exception 'Run as postgres'; end if; end $$;
create function public.admin_generation(phase text,token uuid,fingerprint text default null,choices text[] default null,used_model text default null,uncertain boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; result jsonb;
begin
 actor:=public.admin_assert();
 if phase='reserve' then
  -- Never override per-image/daily quotas; suggestions share the existing allowance.
  result:=public.caption_generation_reserve(actor,fingerprint,token,12,24);
 elsif phase='finish' then
  result:=public.caption_generation_finish(actor,token,choices,used_model,'Admin image-grounded Gemini caption suggestions',uncertain);
 else raise exception 'Invalid generation phase' using errcode='22023'; end if;
 return result;
end $$;
alter function public.admin_generation(text,uuid,text,text[],text,boolean) owner to postgres;
revoke all on function public.admin_generation(text,uuid,text,text[],text,boolean) from public,anon,authenticated,service_role;
do $$ declare g record; begin
 for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid='public.admin_generation(text,uuid,text,text[],text,boolean)'::regprocedure and a.grantee<>p.proowner loop
 execute format('revoke all on function public.admin_generation(text,uuid,text,text[],text,boolean) from %I cascade',g.rolname);
 end loop;
end $$;
grant execute on function public.admin_generation(text,uuid,text,text[],text,boolean) to authenticated;
commit;
