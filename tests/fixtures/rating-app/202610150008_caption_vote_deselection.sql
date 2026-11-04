-- Additive migration after 001–007. Apply manually as postgres; no prior files change.
begin;
set local search_path=pg_catalog,pg_temp;
do $$ begin
 if current_user <> 'postgres' then raise exception 'Run as postgres in Supabase SQL Editor.'; end if;
 if to_regprocedure('public.caption_version_vote(uuid,uuid,boolean)') is null
    or to_regprocedure('public.humor_hub_snapshot()') is null then
   raise exception 'Apply the existing version voting and Humor Hub migrations first.';
 end if;
end $$;

-- Explicit removal is idempotent, unlike a server-side toggle. A retry cannot
-- accidentally recreate a vote. No direct DELETE privilege/policy is granted.
create function public.caption_version_unvote(target_caption uuid,expected_version uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=auth.uid(); active uuid;
begin
 if caller is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if target_caption is null or expected_version is null then
   raise exception 'Caption and version required' using errcode='22023';
 end if;
 -- Same caption lock as the existing vote guard and publication/restoration:
 -- serialize deletion with votes and reject stale/archived version requests.
 select c.active_version_id into active from public.captions c
 join public.caption_versions v on v.id=c.active_version_id and v.caption_id=c.id
   and v.archived_at is null and v.published_at=c.feed_published_at
 where c.id=target_caption for update of c;
 if not found then raise exception 'Published slide not found' using errcode='23503'; end if;
 if active is distinct from expected_version then
   raise exception 'Published version changed. Reload before voting.' using errcode='40001';
 end if;
 delete from public.caption_votes
 where user_id=caller and caption_id=target_caption and version_id=expected_version;
 -- Historical participation, version-rating and XP ledgers intentionally survive.
 return public.caption_active_items(array[target_caption])->0;
end $$;
alter function public.caption_version_unvote(uuid,uuid) owner to postgres;
revoke all on function public.caption_version_unvote(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.caption_version_unvote(uuid,uuid) to authenticated;
commit;
