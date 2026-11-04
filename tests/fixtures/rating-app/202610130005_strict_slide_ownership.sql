-- Additive permission safeguards. No records, votes, images or grants are removed.
begin;
-- Creator identity is permanent, including privileged application RPC updates.
create function public.guard_caption_identity() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.creator_id is distinct from old.creator_id or new.id is distinct from old.id then
   raise exception 'Slide identity and original creator cannot be reassigned' using errcode='42501';
 end if;
 return new;
end $$;
create trigger caption_original_identity before update on public.captions
 for each row execute function public.guard_caption_identity();
revoke all on function public.guard_caption_identity() from public,anon,authenticated;
-- Restrictive fences compose with existing policies. Raw mutations remain
-- ungranted; validated service-only RPCs separately verify their trusted actor.
create policy captions_creator_select_fence on public.captions as restrictive for select to authenticated
 using (creator_id=(select auth.uid()));
create policy captions_creator_update_fence on public.captions as restrictive for update to authenticated
 using (creator_id=(select auth.uid())) with check (creator_id=(select auth.uid()));
create policy captions_creator_delete_fence on public.captions as restrictive for delete to authenticated
 using (creator_id=(select auth.uid()));
create policy versions_creator_select_fence on public.caption_versions as restrictive for select to authenticated
 using (exists(select 1 from public.captions c where c.id=caption_id and c.creator_id=(select auth.uid())));
create policy versions_creator_insert_fence on public.caption_versions as restrictive for insert to authenticated
 with check (exists(select 1 from public.captions c where c.id=caption_id and c.creator_id=(select auth.uid())));
create policy versions_creator_update_fence on public.caption_versions as restrictive for update to authenticated
 using (exists(select 1 from public.captions c where c.id=caption_id and c.creator_id=(select auth.uid())))
 with check (exists(select 1 from public.captions c where c.id=caption_id and c.creator_id=(select auth.uid())));
create policy versions_creator_delete_fence on public.caption_versions as restrictive for delete to authenticated
 using (exists(select 1 from public.captions c where c.id=caption_id and c.creator_id=(select auth.uid())));
-- Published viewing/voting RPCs and existing private image owner/path policies
-- are unchanged. No direct caption/version UPDATE/DELETE grants are introduced.
commit;
