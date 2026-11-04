-- Additive only. Apply manually after 001–005. UTC throughout.
-- Participation rewards and daily goals count a logical slide only once, ever.
-- Immutable ledgers deliberately survive slide/version deletion. No mutable client counters.
begin;
-- Prevent writes between the historical snapshot and trigger installation.
-- Reads stay available; waiting writers resume after this transaction commits.
lock table public.caption_votes, public.captions in share row exclusive mode;
create table public.hub_participation (
 user_id uuid not null references auth.users(id) on delete cascade,
 caption_id uuid not null, first_at timestamptz not null,
 primary key(user_id,caption_id)
);
create table public.hub_version_ratings (
 user_id uuid not null references auth.users(id) on delete cascade,
 version_id uuid not null, caption_id uuid not null, first_at timestamptz not null,
 primary key(user_id,version_id)
);
create table public.hub_creations (
 user_id uuid not null references auth.users(id) on delete cascade,
 caption_id uuid primary key, first_at timestamptz not null
);
create table public.hub_xp_events (
 user_id uuid not null references auth.users(id) on delete cascade,
 event_key text not null, amount integer not null check(amount>0),
 earned_at timestamptz not null, primary key(user_id,event_key)
);
create table public.hub_achievements (
 user_id uuid not null references auth.users(id) on delete cascade,
 achievement text not null check(achievement in ('first_vote','votes_100','streak_7','first_slide','votes_500')),
 unlocked_at timestamptz not null, primary key(user_id,achievement)
);
create index hub_weekly_xp on public.hub_xp_events(earned_at,user_id) include(amount);
create index hub_activity_days on public.hub_participation(user_id,first_at);
create index hub_created_user on public.hub_creations(user_id);
create index hub_versions_user on public.hub_version_ratings(user_id);
alter table public.hub_participation enable row level security;
alter table public.hub_version_ratings enable row level security;
alter table public.hub_creations enable row level security;
alter table public.hub_xp_events enable row level security;
alter table public.hub_achievements enable row level security;
revoke all on public.hub_participation,public.hub_version_ratings,public.hub_creations,public.hub_xp_events,public.hub_achievements from public,anon,authenticated,service_role;
-- Snapshot functions expose only the caller's private activity and public pseudonymous ranks.
create function public.hub_streak(actor uuid, as_of date) returns table(current_streak integer,longest_streak integer)
language sql stable security definer set search_path='' as $$
 with days as (select distinct (first_at at time zone 'UTC')::date d from public.hub_participation where user_id=actor and (first_at at time zone 'UTC')::date<=as_of),
 islands as (select d,d-(row_number() over(order by d))::integer grp from days),
 runs as (select count(*)::integer n,max(d) last_day from islands group by grp)
 select coalesce((select n from runs where last_day in (as_of,as_of-1) order by last_day desc limit 1),0),
        coalesce((select max(n) from runs),0);
$$;
create function public.hub_unlock(actor uuid, badge text, reward integer, stamp timestamptz) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into public.hub_achievements values(actor,badge,stamp) on conflict do nothing;
 if found then insert into public.hub_xp_events values(actor,'achievement:'||badge,reward,stamp) on conflict do nothing; end if;
end $$;
create function public.hub_process(actor uuid, stamp timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare milestone record; first_creation timestamptz; seventh_day_vote timestamptz;
begin
 -- Derive unlock dates from qualifying activity, never the processing/migration time.
 -- The cutoff also makes historical replay safe if this helper is used for an earlier instant.
 for milestone in
   select rn,first_at from (
     select first_at,row_number() over(order by first_at,caption_id) rn
     from public.hub_participation where user_id=actor and first_at<=stamp
   ) ordered where rn in (1,100,500)
 loop
   perform public.hub_unlock(actor,
     case milestone.rn when 1 then 'first_vote' when 100 then 'votes_100' else 'votes_500' end,
     case milestone.rn when 1 then 25 when 100 then 50 else 100 end,milestone.first_at);
 end loop;
 select min(first_at) into first_creation from public.hub_creations where user_id=actor and first_at<=stamp;
 if first_creation is not null then perform public.hub_unlock(actor,'first_slide',25,first_creation); end if;
 with days as (
   select (first_at at time zone 'UTC')::date d,min(first_at) first_vote
   from public.hub_participation where user_id=actor and first_at<=stamp
   group by (first_at at time zone 'UTC')::date
 ), islands as (
   select d,first_vote,d-(row_number() over(order by d))::integer grp from days
 ), runs as (
   select first_vote,row_number() over(partition by grp order by d) rn from islands
 ) select min(first_vote) into seventh_day_vote from runs where rn=7;
 if seventh_day_vote is not null then perform public.hub_unlock(actor,'streak_7',100,seventh_day_vote); end if;
 insert into public.hub_xp_events(user_id,event_key,amount,earned_at)
 select actor,'goal:'||to_char(activity_day,'YYYY-MM-DD'),30,completed from (
   select (first_at at time zone 'UTC')::date as activity_day, max(first_at) completed from (
     select first_at,row_number() over(partition by (first_at at time zone 'UTC')::date order by first_at,caption_id) rn
     from public.hub_participation where user_id=actor and first_at<=stamp
   ) ranked where rn<=3 group by (first_at at time zone 'UTC')::date having count(*)=3
 ) goals on conflict do nothing;
end $$;
create function public.hub_vote_record() returns trigger language plpgsql security definer set search_path='' as $$
declare stamp timestamptz;
begin
 -- Same lock for all of a user's participation/creation events, including direct RLS writes.
 if tg_relid<>'public.caption_votes'::regclass or tg_op<>'INSERT' then raise exception 'Invalid Hub vote trigger context'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hub:'||new.user_id::text,0));
 stamp:=clock_timestamp();
 insert into public.hub_version_ratings values(new.user_id,new.version_id,new.caption_id,stamp) on conflict do nothing;
 insert into public.hub_participation values(new.user_id,new.caption_id,stamp) on conflict do nothing;
 if found then
   insert into public.hub_xp_events values(new.user_id,'vote:'||new.caption_id::text,10,stamp) on conflict do nothing;
   perform public.hub_process(new.user_id,stamp);
 end if;
 return new;
end $$;
create function public.hub_creation_record() returns trigger language plpgsql security definer set search_path='' as $$
declare stamp timestamptz;
begin
 if tg_relid<>'public.captions'::regclass or tg_op<>'INSERT' then raise exception 'Invalid Hub creation trigger context'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hub:'||new.creator_id::text,0));
 stamp:=clock_timestamp();
 insert into public.hub_creations values(new.creator_id,new.id,stamp) on conflict do nothing;
 if found then
   insert into public.hub_xp_events values(new.creator_id,'create:'||new.id::text,25,stamp) on conflict do nothing;
   perform public.hub_process(new.creator_id,stamp);
 end if;
 return new;
end $$;
-- Existing users receive participation and publication XP dated to original activity,
-- not migration time. No weekly XP windfall from historical base rewards/goals.
insert into public.hub_version_ratings select user_id,version_id,caption_id,min(created_at) from public.caption_votes group by user_id,version_id,caption_id;
insert into public.hub_participation select user_id,caption_id,min(created_at) from public.caption_votes group by user_id,caption_id;
insert into public.hub_creations select creator_id,id,created_at from public.captions;
insert into public.hub_xp_events select user_id,'vote:'||caption_id::text,10,first_at from public.hub_participation;
insert into public.hub_xp_events select user_id,'create:'||caption_id::text,25,first_at from public.hub_creations;
-- One reward algorithm for backfill and live writes. Each user is processed once,
-- at their last recorded historical activity; no reward is dated to migration time.
do $$ declare r record; begin
 for r in
   select user_id,max(first_at) stamp from (
     select user_id,first_at from public.hub_participation
     union all select user_id,first_at from public.hub_creations
   ) activity group by user_id
 loop perform public.hub_process(r.user_id,r.stamp); end loop;
end $$;
create trigger hub_vote_record after insert on public.caption_votes for each row execute function public.hub_vote_record();
create trigger hub_creation_record after insert on public.captions for each row execute function public.hub_creation_record();
create function public.humor_hub_snapshot() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); stamp timestamptz:=now(); week_start timestamptz; xp bigint; streak record; leaders jsonb; own_rank jsonb;
begin
 if actor is null then raise exception 'Sign in required' using errcode='42501'; end if;
 week_start:=date_trunc('week',stamp at time zone 'UTC') at time zone 'UTC';
 select coalesce(sum(amount),0) into xp from public.hub_xp_events where user_id=actor;
 select * into streak from public.hub_streak(actor,(stamp at time zone 'UTC')::date);
 with scores as (select user_id,sum(amount)::bigint weekly_xp from public.hub_xp_events where earned_at>=week_start and earned_at<week_start+interval '168 hours' group by user_id),
 ranked as (select user_id,weekly_xp,row_number() over(order by weekly_xp desc,user_id) position from scores),
 -- IDs stay internal to scores/ranked. Serialize only this explicit public allowlist.
 safe as (select position,user_id=actor is_you,jsonb_build_object(
   'position',position,'weekly_xp',weekly_xp,'is_you',user_id=actor,
   'display_name','Rater '||left(md5(user_id::text),8)
 ) payload from ranked)
 select coalesce(jsonb_agg(payload order by position) filter(where position<=20),'[]'::jsonb),
 (jsonb_agg(payload) filter(where is_you))->0 into leaders,own_rank from safe;
 return jsonb_build_object('xp',xp,'streak',streak.current_streak,'longest_streak',streak.longest_streak,
 'rated_versions',(select count(*) from public.hub_version_ratings where user_id=actor),
 'created',(select count(*) from public.hub_creations where user_id=actor),
 'daily',(select count(*) from public.hub_participation where user_id=actor and first_at>=date_trunc('day',stamp at time zone 'UTC') at time zone 'UTC' and first_at< (date_trunc('day',stamp at time zone 'UTC')+interval '1 day') at time zone 'UTC'),
 'day',(stamp at time zone 'UTC')::date,'week_start',week_start,'leaders',leaders,'your_rank',own_rank,
 'achievements',(select coalesce(jsonb_agg(achievement order by achievement),'[]'::jsonb) from public.hub_achievements where user_id=actor));
end $$;
revoke all on function public.hub_streak(uuid,date),public.hub_unlock(uuid,text,integer,timestamptz),public.hub_process(uuid,timestamptz),public.hub_vote_record(),public.hub_creation_record(),public.humor_hub_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.humor_hub_snapshot() to authenticated;
commit;
