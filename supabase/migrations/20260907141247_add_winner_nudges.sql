-- 지난 주차 우승자의 잔소리 발송권. 권한과 사용량은 서버가 정산 결과에서만 만든다.
alter type public.notification_kind add value if not exists 'winner_nudge';

alter table public.notifications
  add column if not exists body text,
  add constraint notifications_body_length
    check (body is null or char_length(body) between 1 and 500);

create table public.winner_nudge_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  source_period_id uuid not null references public.periods (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  winner_user_id uuid not null references public.profiles (id) on delete cascade,
  max_send_count integer,
  daily_limit smallint not null,
  sent_count integer not null default 0,
  daily_sent_count smallint not null default 0,
  daily_send_on date,
  last_sent_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint winner_nudge_grants_one_per_winner unique (source_period_id, winner_user_id),
  constraint winner_nudge_grants_max_send_count check (max_send_count is null or max_send_count between 1 and 10),
  constraint winner_nudge_grants_daily_limit check (daily_limit between 1 and 10),
  constraint winner_nudge_grants_counts check (sent_count >= 0 and daily_sent_count >= 0),
  constraint winner_nudge_grants_expiry check (expires_at > created_at)
);

create index winner_nudge_grants_user_room_idx
  on public.winner_nudge_grants (winner_user_id, room_id, expires_at desc);

create table public.winner_nudge_recipients (
  grant_id uuid not null references public.winner_nudge_grants (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (grant_id, user_id)
);

create table public.winner_nudge_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  grant_id uuid not null references public.winner_nudge_grants (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  source_period_id uuid not null references public.periods (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint winner_nudge_messages_body check (char_length(btrim(body)) between 1 and 80)
);

create index winner_nudge_messages_grant_created_idx
  on public.winner_nudge_messages (grant_id, created_at desc);

alter table public.winner_nudge_grants enable row level security;
alter table public.winner_nudge_recipients enable row level security;
alter table public.winner_nudge_messages enable row level security;

create policy winner_nudge_grants_read_own
on public.winner_nudge_grants
for select to authenticated
using ((select auth.uid()) = winner_user_id);

-- Finalization inserts every result for a period in one statement. This helper
-- derives the shared/solo policy from that immutable snapshot, then snapshots
-- the eligible recipients from the same period.
create function private.ensure_winner_nudge_grants(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period public.periods%rowtype;
  v_crown_count integer;
begin
  select p.* into v_period from public.periods p where p.id = p_period_id;
  if v_period.id is null then return; end if;

  select count(*)::integer into v_crown_count
  from public.period_results r
  where r.period_id = p_period_id and r.is_crown;
  if v_crown_count = 0 then return; end if;

  insert into public.winner_nudge_grants (
    source_period_id, room_id, winner_user_id, max_send_count, daily_limit, expires_at
  )
  select
    p_period_id,
    v_period.room_id,
    r.user_id,
    case when v_crown_count = 1 then null else 1 end,
    case when v_crown_count = 1 then 10 else 1 end,
    v_period.finalizes_at + interval '7 days'
  from public.period_results r
  where r.period_id = p_period_id and r.is_crown
  on conflict (source_period_id, winner_user_id) do nothing;

  insert into public.winner_nudge_recipients (grant_id, user_id)
  select g.id, pm.user_id
  from public.winner_nudge_grants g
  join public.period_members pm on pm.period_id = g.source_period_id
  where g.source_period_id = p_period_id
    and pm.status = 'active'
    and pm.user_id <> g.winner_user_id
  on conflict do nothing;
end;
$$;

create function private.create_winner_nudge_grants_after_results()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_period_id uuid;
begin
  for v_period_id in select distinct period_id from inserted_results loop
    perform private.ensure_winner_nudge_grants(v_period_id);
  end loop;
  return null;
end;
$$;

create trigger period_results_create_winner_nudge_grants
after insert on public.period_results
referencing new table as inserted_results
for each statement execute function private.create_winner_nudge_grants_after_results();

-- Existing recent settlements are backfilled once so a deployment during the
-- next week still gives its already-finalized winner the intended entitlement.
select private.ensure_winner_nudge_grants(p.id)
from public.periods p
where p.finalized_at is not null
  and p.finalizes_at + interval '7 days' > statement_timestamp();

create function private.send_winner_nudge_impl(
  p_room_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_grant public.winner_nudge_grants%rowtype;
  v_message public.winner_nudge_messages%rowtype;
  v_today date := timezone('Asia/Seoul', statement_timestamp())::date;
  v_today_count smallint;
  v_recipient_ids uuid[];
  v_notification_ids uuid[];
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if p_room_id is null or p_body is null or char_length(btrim(p_body)) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'invalid winner nudge';
  end if;

  select g.* into v_grant
  from public.winner_nudge_grants g
  where g.room_id = p_room_id
    and g.winner_user_id = v_user_id
    and g.expires_at > statement_timestamp()
    and (g.max_send_count is null or g.sent_count < g.max_send_count)
  order by g.expires_at desc
  limit 1
  for update;
  if v_grant.id is null then raise exception using errcode = '42501', message = 'winner nudge privilege unavailable'; end if;

  v_today_count := case when v_grant.daily_send_on = v_today then v_grant.daily_sent_count else 0 end;
  if v_today_count >= v_grant.daily_limit then
    raise exception using errcode = '22023', message = 'winner nudge daily limit reached';
  end if;
  if v_grant.last_sent_at is not null and v_grant.last_sent_at > statement_timestamp() - interval '30 minutes' then
    raise exception using errcode = '22023', message = 'winner nudge cooldown active';
  end if;

  insert into public.winner_nudge_messages (grant_id, room_id, source_period_id, author_id, body)
  values (v_grant.id, v_grant.room_id, v_grant.source_period_id, v_user_id, btrim(p_body))
  returning * into v_message;

  with recipients as (
    select r.user_id
    from public.winner_nudge_recipients r
    join public.room_members rm on rm.room_id = v_grant.room_id and rm.user_id = r.user_id
    where r.grant_id = v_grant.id and rm.status = 'active'
  ), inserted as (
    insert into public.notifications (user_id, kind, actor_id, room_id, period_id, route, dedupe_key, body)
    select user_id, 'winner_nudge', v_user_id, v_grant.room_id, v_grant.source_period_id,
      '/notifications', 'winner_nudge:' || v_message.id::text || ':' || user_id::text, v_message.body
    from recipients
    returning id, user_id
  )
  select coalesce(array_agg(user_id), '{}'::uuid[]), coalesce(array_agg(id), '{}'::uuid[])
  into v_recipient_ids, v_notification_ids
  from inserted;

  update public.winner_nudge_grants
  set sent_count = sent_count + 1,
      daily_sent_count = v_today_count + 1,
      daily_send_on = v_today,
      last_sent_at = statement_timestamp()
  where id = v_grant.id;

  return jsonb_build_object(
    'message_id', v_message.id,
    'recipient_ids', to_jsonb(v_recipient_ids),
    'notification_ids', to_jsonb(v_notification_ids)
  );
end;
$$;

create function public.send_winner_nudge(p_room_id uuid, p_body text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.send_winner_nudge_impl(p_room_id, p_body); $$;

revoke all on function private.ensure_winner_nudge_grants(uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_winner_nudge_grants_after_results() from public, anon, authenticated, service_role;
revoke all on function private.send_winner_nudge_impl(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.send_winner_nudge(uuid, text) from public, anon, service_role;
grant execute on function public.send_winner_nudge(uuid, text) to authenticated;

grant select on public.winner_nudge_grants to authenticated;
