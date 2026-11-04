-- Image-only generation, private drafts, atomic quotas, and idempotent finalization.
-- Apply after 202610130001. No existing records or policies are removed.
begin;
create table public.caption_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_hash text not null check (image_hash ~ '^[a-f0-9]{64}$'),
  generations integer not null default 0 check (generations between 0 and 3),
  candidates text[], version uuid, model text, generation_prompt text,
  expires_at timestamptz not null default now() + interval '7 days',
  finalized_id uuid unique references public.captions(id),
  unique(user_id,image_hash)
);
create table public.caption_generation_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  used integer not null default 0 check(used>=0),
  dispatched integer not null default 0 check(dispatched>=0),
  primary key(user_id,day)
);
create table public.caption_generation_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  draft_id uuid not null references public.caption_drafts(id) on delete cascade,
  day date not null,
  status text not null check(status in ('pending','completed','failed','uncertain')),
  created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
create index caption_drafts_expiry_idx on public.caption_drafts(expires_at) where candidates is not null;
create index caption_generation_pending_idx on public.caption_generation_requests(draft_id) where status='pending';
alter table public.caption_drafts enable row level security;
alter table public.caption_generation_days enable row level security;
alter table public.caption_generation_requests enable row level security;
revoke all on public.caption_drafts,public.caption_generation_days,public.caption_generation_requests from public,anon,authenticated;
-- Only server-side service credentials may mutate generation state. No user-supplied
-- actor reaches these functions: HTTP handlers derive it from auth.getUser().
grant all on public.caption_drafts,public.caption_generation_days,public.caption_generation_requests to service_role;

create function public.caption_draft_state(actor uuid, target uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',d.id,'remaining',3-d.generations,
    'candidates',case when d.expires_at>now() then to_jsonb(d.candidates) else null end,
    'version',d.version,'expires_at',d.expires_at,'finalized_id',d.finalized_id,
    'pending',exists(select 1 from public.caption_generation_requests r where r.draft_id=d.id and r.status='pending' and r.created_at>now()-interval '2 minutes'))
  from public.caption_drafts d where d.id=target and d.user_id=actor;
$$;

create function public.caption_generation_reserve(actor uuid, fingerprint text, token uuid, daily_limit integer default 12, dispatch_limit integer default 24)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.caption_drafts%rowtype; r public.caption_generation_requests%rowtype; q public.caption_generation_days%rowtype;
  today date := (now() at time zone 'UTC')::date;
begin
  if actor is null or token is null or fingerprint !~ '^[a-f0-9]{64}$' or daily_limit not between 1 and 100 or dispatch_limit not between 1 and 200 then raise exception 'Invalid generation reservation'; end if;
  -- Serialize across all images for this user, including simultaneous first drafts.
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  insert into public.caption_drafts(user_id,image_hash) values(actor,fingerprint) on conflict(user_id,image_hash) do nothing;
  select * into d from public.caption_drafts where user_id=actor and image_hash=fingerprint for update;
  select * into r from public.caption_generation_requests where user_id=actor and request_id=token;
  if found then
    if r.draft_id<>d.id then raise exception 'Request ID belongs to another image'; end if;
    return jsonb_build_object('dispatch',false,'status',r.status,'draft',public.caption_draft_state(actor,d.id));
  end if;
  if d.finalized_id is not null then return jsonb_build_object('dispatch',false,'status','finalized','draft',public.caption_draft_state(actor,d.id)); end if;
  -- A crashed or ambiguous request is never re-dispatched. Its reservation remains
  -- charged because Gemini may have processed it; this bounds calls after crashes.
  update public.caption_generation_requests set status='uncertain' where draft_id=d.id and status='pending' and created_at<=now()-interval '2 minutes';
  if exists(select 1 from public.caption_generation_requests where draft_id=d.id and status='pending') then
    return jsonb_build_object('dispatch',false,'status','pending','draft',public.caption_draft_state(actor,d.id));
  end if;
  if d.generations>=3 then return jsonb_build_object('dispatch',false,'status','image_limit','draft',public.caption_draft_state(actor,d.id)); end if;
  insert into public.caption_generation_days(user_id,day) values(actor,today) on conflict do nothing;
  select * into q from public.caption_generation_days where user_id=actor and day=today for update;
  if q.used>=daily_limit or q.dispatched>=dispatch_limit then return jsonb_build_object('dispatch',false,'status','daily_limit','draft',public.caption_draft_state(actor,d.id)); end if;
  update public.caption_generation_days set used=used+1,dispatched=dispatched+1 where user_id=actor and day=today;
  update public.caption_drafts set generations=generations+1,expires_at=now()+interval '7 days' where id=d.id;
  insert into public.caption_generation_requests(user_id,request_id,draft_id,day,status) values(actor,token,d.id,today,'pending');
  return jsonb_build_object('dispatch',true,'status','pending','draft',public.caption_draft_state(actor,d.id));
end $$;

create function public.caption_generation_finish(actor uuid, token uuid, choices text[] default null, used_model text default null, used_prompt text default null, uncertain boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.caption_generation_requests%rowtype; d public.caption_drafts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  select * into r from public.caption_generation_requests where user_id=actor and request_id=token for update;
  if not found then raise exception 'Unknown generation request'; end if;
  select * into d from public.caption_drafts where id=r.draft_id for update;
  if r.status<>'pending' then return public.caption_draft_state(actor,d.id); end if;
  if choices is not null then
    if cardinality(choices)<>3 or (select count(distinct lower(btrim(c))) from unnest(choices) c)<>3
      or exists(select 1 from unnest(choices) c where c is null or length(btrim(c)) not between 1 and 280)
      or used_model is null or length(used_model) not between 1 and 100 or used_prompt is null or length(used_prompt) not between 1 and 5000 then raise exception 'Invalid caption candidates'; end if;
    update public.caption_drafts set candidates=choices,version=token,model=used_model,generation_prompt=used_prompt where id=d.id;
    update public.caption_generation_requests set status='completed' where user_id=actor and request_id=token;
  elsif uncertain then
    update public.caption_generation_requests set status='uncertain' where user_id=actor and request_id=token;
  else
    -- Explicit failures refund the per-image and successful daily quota. The hard
    -- dispatch quota still counts the call to prevent repeated-failure abuse.
    update public.caption_drafts set generations=generations-1 where id=d.id;
    update public.caption_generation_days set used=used-1 where user_id=actor and day=r.day;
    update public.caption_generation_requests set status='failed' where user_id=actor and request_id=token;
  end if;
  return public.caption_draft_state(actor,d.id);
end $$;

create function public.caption_draft_finalize(actor uuid, target uuid, fingerprint text, candidate_version uuid, selection integer, saved_path text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.caption_drafts%rowtype; caption_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  select * into d from public.caption_drafts where id=target and user_id=actor for update;
  if not found or d.image_hash<>fingerprint then raise exception 'Draft does not match this image'; end if;
  if d.finalized_id is not null then return jsonb_build_object('id',d.finalized_id); end if;
  if d.expires_at<=now() or d.version is distinct from candidate_version or d.candidates is null or selection not between 0 and 2 or selection is null then raise exception 'Select a current caption from this draft'; end if;
  update public.caption_generation_requests set status='uncertain' where draft_id=d.id and status='pending' and created_at<=now()-interval '2 minutes';
  if exists(select 1 from public.caption_generation_requests where draft_id=d.id and status='pending') then raise exception 'Generation is still in progress'; end if;
  if saved_path not like actor::text||'/'||d.id::text||'-%' or not exists(select 1 from storage.objects where bucket_id='caption-images' and name=saved_path and owner_id=actor::text) then raise exception 'Image ownership could not be verified'; end if;
  insert into public.captions(creator_id,image_path,user_prompt,generation_prompt,caption,model)
    values(actor,saved_path,'Image-only caption generation',d.generation_prompt,d.candidates[selection+1],d.model) returning id into caption_id;
  update public.caption_drafts set finalized_id=caption_id where id=d.id;
  return jsonb_build_object('id',caption_id);
end $$;

-- Preserve ownership policies; add a fence so direct browser inserts cannot bypass
-- validated candidates, quotas, or idempotency. The narrow server finalizer inserts.
create policy captions_verified_creation on public.captions as restrictive for insert to authenticated with check(false);

create function public.cleanup_caption_drafts() returns void language sql security definer set search_path='' as $$
  update public.caption_drafts set candidates=null,model=null,generation_prompt=null
  where expires_at<=now() and candidates is not null;
$$;
-- Keep hash/counters and request tombstones: deleting them would reset limits.
-- Cleanup needs no paid scheduler: the server runs it opportunistically.
revoke all on function public.caption_draft_state(uuid,uuid),public.caption_generation_reserve(uuid,text,uuid,integer,integer),public.caption_generation_finish(uuid,uuid,text[],text,text,boolean),public.caption_draft_finalize(uuid,uuid,text,uuid,integer,text),public.cleanup_caption_drafts() from public,anon,authenticated;
grant execute on function public.caption_draft_state(uuid,uuid),public.caption_generation_reserve(uuid,text,uuid,integer,integer),public.caption_generation_finish(uuid,uuid,text[],text,text,boolean),public.caption_draft_finalize(uuid,uuid,text,uuid,integer,text),public.cleanup_caption_drafts() to service_role;
commit;
