-- Unified feed. Preserve the RPC signature for existing clients; selected_month is ignored.
-- No records, voting functions, or RLS policies are changed.
begin;
create or replace function public.caption_deck_snapshot(
  selected_month text default null,
  seen_created_at timestamptz default null,
  seen_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  caller uuid := auth.uid();
  slide_rows jsonb;
  latest public.captions%rowtype;
  fresh bigint := 0;
begin
  if caller is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'created_at',c.created_at,'my_vote',v.value)
    order by c.created_at desc,c.id desc),'[]'::jsonb) into slide_rows
  from public.captions c
  left join public.caption_votes v on v.caption_id=c.id and v.user_id=caller;
  select * into latest from public.captions c order by c.created_at desc,c.id desc limit 1;
  if seen_created_at is not null then
    select count(*) into fresh from public.captions c
      where (c.created_at,c.id) > (seen_created_at,coalesce(seen_id,'00000000-0000-0000-0000-000000000000'::uuid));
  end if;
  return jsonb_build_object('slides',slide_rows,
    'latest',case when latest.id is null then null else jsonb_build_object('id',latest.id,'created_at',latest.created_at) end,
    'new_count',fresh);
end $$;
revoke all on function public.caption_deck_snapshot(text,timestamptz,uuid) from public,anon;
grant execute on function public.caption_deck_snapshot(text,timestamptz,uuid) to authenticated;


commit;
