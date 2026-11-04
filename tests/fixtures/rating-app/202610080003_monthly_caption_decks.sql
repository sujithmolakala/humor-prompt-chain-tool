-- NEW incremental migration. Run once after 202610080002. No data is deleted.
begin;

create index captions_deck_month_newest_idx on public.captions
  ((date_trunc('month', created_at at time zone 'America/New_York')), created_at desc, id desc);

-- One JSON snapshot avoids PostgREST's row cap truncating the month manifest.
-- It contains IDs/timestamps/own vote state, never images, prompts or voter IDs.
create function public.caption_deck_snapshot(
  selected_month text default null,
  seen_created_at timestamptz default null,
  seen_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  caller uuid := auth.uid();
  chosen text;
  month_rows jsonb;
  slide_rows jsonb;
  latest public.captions%rowtype;
  fresh bigint := 0;
begin
  if caller is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if selected_month is not null and selected_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.month desc),'[]'::jsonb) into month_rows from (
    select to_char(c.created_at at time zone 'America/New_York','YYYY-MM') as month,
      count(*) as total,
      count(v.id) as voted
    from public.captions c
    left join public.caption_votes v on v.caption_id=c.id and v.user_id=caller
    group by 1
  ) m;
  chosen := selected_month;
  if chosen is null or not exists(select 1 from jsonb_array_elements(month_rows) m where m->>'month'=chosen) then
    chosen := month_rows->0->>'month';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'created_at',c.created_at,'my_vote',v.value)
    order by c.created_at desc,c.id desc),'[]'::jsonb) into slide_rows
  from public.captions c
  left join public.caption_votes v on v.caption_id=c.id and v.user_id=caller
  where to_char(c.created_at at time zone 'America/New_York','YYYY-MM')=chosen;
  select * into latest from public.captions c order by c.created_at desc,c.id desc limit 1;
  if seen_created_at is not null then
    select count(*) into fresh from public.captions c
      where (c.created_at,c.id) > (seen_created_at,coalesce(seen_id,'00000000-0000-0000-0000-000000000000'::uuid));
  end if;
  return jsonb_build_object('months',month_rows,'month',chosen,'slides',slide_rows,
    'latest',case when latest.id is null then null else jsonb_build_object('id',latest.id,'created_at',latest.created_at,
      'month',to_char(latest.created_at at time zone 'America/New_York','YYYY-MM')) end,
    'new_count',fresh);
end $$;
revoke all on function public.caption_deck_snapshot(text,timestamptz,uuid) from public,anon;
grant execute on function public.caption_deck_snapshot(text,timestamptz,uuid) to authenticated;

-- Bounded detail batches. UUID identity remains stable when new rows are inserted;
-- the browser slices the complete manifest rather than using shifting offsets.
create function public.caption_deck_items(caption_ids uuid[])
returns table(id uuid,image_path text,caption text,model text,created_at timestamptz,funny_count bigint,not_funny_count bigint,my_vote boolean)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if coalesce(cardinality(caption_ids),0)>48 then raise exception 'At most 48 caption IDs' using errcode='22023'; end if;
  return query
    select c.id,c.image_path,c.caption,c.model,c.created_at,
      coalesce(t.funny,0),coalesce(t.not_funny,0),mine.value
    from public.captions c
    left join lateral (
      select count(*) filter(where v.value) as funny,count(*) filter(where not v.value) as not_funny
      from public.caption_votes v where v.caption_id=c.id
    ) t on true
    left join public.caption_votes mine on mine.caption_id=c.id and mine.user_id=auth.uid()
    where c.id=any(caption_ids)
    order by c.created_at desc,c.id desc;
end $$;
revoke all on function public.caption_deck_items(uuid[]) from public,anon;
grant execute on function public.caption_deck_items(uuid[]) to authenticated;

-- Preserve the existing RLS-backed first INSERT / subsequent UPDATE function.
-- Return saved selection and authoritative totals in the same transaction.
create function public.caption_deck_vote(target_caption uuid,vote_value boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform public.cast_caption_vote(target_caption,vote_value);
  select to_jsonb(item) into result from public.caption_deck_items(array[target_caption]) item;
  return result;
end $$;
revoke all on function public.caption_deck_vote(uuid,boolean) from public,anon;
grant execute on function public.caption_deck_vote(uuid,boolean) to authenticated;

-- Existing table RLS, storage policies, captions, votes, and avatars are unchanged.
commit;
