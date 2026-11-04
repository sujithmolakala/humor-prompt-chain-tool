-- Manual additive migration AFTER 001–006. Run as postgres in SQL Editor.
-- The app is member-only: published slides are shared through RPCs, while raw
-- caption/version rows and individual votes remain owner-only under RLS.
begin;
set local search_path=pg_catalog,pg_temp;

do $$
begin
  if current_user <> 'postgres' then
    raise exception 'Run this migration as postgres (Supabase SQL Editor).';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='caption_ranked_page'
      and p.oid is distinct from pg_catalog.to_regprocedure('public.caption_ranked_page(bigint)')) then
    raise exception 'Unexpected caption_ranked_page overload. Review it before applying this migration.';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute
    where attrelid='public.caption_votes'::regclass and attname='value'
      and atttypid='pg_catalog.bool'::regtype and attnotnull and not attisdropped) then
    raise exception 'Expected caption_votes.value boolean NOT NULL. No changes applied.';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute
    where attrelid='public.captions'::regclass and attname='active_version_id'
      and atttypid='pg_catalog.uuid'::regtype and attnotnull and not attisdropped)
    or not exists (select 1 from pg_catalog.pg_attribute
    where attrelid='public.captions'::regclass and attname='feed_published_at'
      and atttypid='pg_catalog.timestamptz'::regtype and attnotnull and not attisdropped) then
    raise exception 'Expected versioned publication schema from migration 004. No changes applied.';
  end if;
end $$;

create or replace function public.caption_ranked_page(page_offset bigint default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  caller uuid := auth.uid();
  safe_offset bigint := greatest(coalesce(page_offset,0),0);
begin
  if caller is null or not exists(select 1 from auth.users where id=caller) then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',r.id,'version_id',r.version_id,'created_at',r.created_at,
      'updated_at',r.updated_at,'my_vote',r.my_vote
    ) order by r.score desc,r.created_at desc,r.id desc),'[]'::jsonb)
    from (
      select c.id,c.active_version_id as version_id,c.feed_published_at as created_at,
        c.updated_at,mine.value as my_vote,t.score
      from public.captions c
      -- Drafts live in separate tables. Fail closed on inconsistent publication
      -- pointers, archived active versions, or mismatched publication timestamps.
      join public.caption_versions active on active.id=c.active_version_id
        and active.caption_id=c.id and active.archived_at is null
        and active.published_at=c.feed_published_at
      cross join lateral (
        select count(*) filter(where votes.value is true)
             - count(*) filter(where votes.value is false) as score
        from public.caption_votes votes
        where votes.version_id=c.active_version_id and votes.caption_id=c.id
      ) t
      left join public.caption_votes mine on mine.version_id=c.active_version_id
        and mine.caption_id=c.id and mine.user_id=caller
      -- Score every eligible logical slide BEFORE applying the page boundary.
      order by t.score desc,c.feed_published_at desc,c.id desc
      limit 24 offset safe_offset
    ) r
  );
end $$;
alter function public.caption_ranked_page(bigint) owner to postgres;

-- CREATE OR REPLACE retains previous ACLs. Clear every non-owner grant,
-- including custom/default grants, before granting only the member role.
revoke all on function public.caption_ranked_page(bigint) from public;
do $$
declare grantee_name text;
begin
  for grantee_name in
    select distinct roles.rolname
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(p.proacl) acl
    join pg_catalog.pg_roles roles on roles.oid=acl.grantee
    where p.oid='public.caption_ranked_page(bigint)'::regprocedure
      and acl.grantee<>p.proowner
  loop
    execute pg_catalog.format('revoke all on function public.caption_ranked_page(bigint) from %I cascade',grantee_name);
  end loop;
end $$;
grant execute on function public.caption_ranked_page(bigint) to authenticated;
do $$ begin
  if pg_catalog.has_function_privilege('anon','public.caption_ranked_page(bigint)','execute') then
    raise exception 'anon inherits EXECUTE through role membership. Review role grants; no changes applied.';
  end if;
end $$;
comment on function public.caption_ranked_page(bigint) is
  'Member-only active published slides; score Funny minus Not Funny, publication DESC, ID DESC; 24 items. NULL/negative offsets mean zero; large offsets are not clamped.';
commit;
