-- NEW incremental migration. Run manually AFTER 202610080001, once.
-- Preserves captions, votes, profiles, avatars, and stored image objects.
begin;

create or replace function public.caption_feed(sort_by text default 'newest', page_offset integer default 0, page_size integer default 12)
returns table(id uuid,image_path text,caption text,model text,created_at timestamptz,funny_count bigint,not_funny_count bigint,my_vote boolean)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  return query
    select c.id,c.image_path,c.caption,c.model,c.created_at,
      coalesce(v.funny,0),coalesce(v.not_funny,0),mine.value
    from public.captions c
    left join (select cv.caption_id,count(*) filter(where cv.value) funny,count(*) filter(where not cv.value) not_funny from public.caption_votes cv group by cv.caption_id) v on v.caption_id=c.id
    left join public.caption_votes mine on mine.caption_id=c.id and mine.user_id=auth.uid()
    order by case when sort_by='top' then coalesce(v.funny,0)-coalesce(v.not_funny,0) else 0 end desc,c.created_at desc,c.id
    limit least(greatest(page_size,1),48) offset least(greatest(page_offset,0),10000);
end $$;
revoke all on function public.caption_feed(text,integer,integer) from public, anon;
grant execute on function public.caption_feed(text,integer,integer) to authenticated;

-- Supabase owns storage.objects and already enables RLS; do not ALTER that table.
-- Keep avatars public to preserve existing avatar_url values and upload behavior.
update storage.buckets set public=false where id='caption-images';

drop policy if exists study_image_read on storage.objects;
create policy study_avatar_read on storage.objects for select to anon,authenticated
  using (bucket_id='avatars');
create policy study_caption_member_read on storage.objects for select to authenticated
  using (bucket_id='caption-images' and (select auth.uid()) is not null);

-- Restrictive policies AND with legacy permissive policies. A generic legacy
-- "read everything" policy must not accidentally restore anonymous caption access.
create policy study_caption_read_fence on storage.objects as restrictive for select to public
  using (bucket_id <> 'caption-images' or (select auth.uid()) is not null);

-- Existing upload/update/delete ownership policies remain untouched.
commit;
