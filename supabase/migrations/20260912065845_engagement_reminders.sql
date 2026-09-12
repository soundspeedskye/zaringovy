-- 24시간 미접속/미게시 리마인더.
-- 원격 푸시만을 위한 내부 상태와 큐이며, 앱 소식함(public.notifications)에는
-- 기본적으로 행을 만들지 않는다.

create extension if not exists pg_net with schema extensions;

create table private.user_engagement_state (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  last_app_active_at timestamptz not null default statement_timestamp(),
  last_post_at timestamptz,
  -- 같은 활동 주기에는 한 번만 보낸다. 앱을 열거나 새 글을 쓰면
  -- reference_at보다 새로운 활동 시각이 생겨 다음 주기가 열린다.
  last_nudge_for_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create table private.engagement_nudge_events (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  reference_at timestamptz not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default statement_timestamp(),
  constraint engagement_nudge_events_reason check (reason in ('inactive', 'no_post')),
  constraint engagement_nudge_events_status check (status in ('pending', 'claimed', 'sent', 'failed')),
  constraint engagement_nudge_events_attempts check (attempt_count >= 0),
  constraint engagement_nudge_events_error_length check (
    last_error is null or char_length(last_error) <= 500
  ),
  unique (user_id, reference_at)
);

alter table private.user_engagement_state enable row level security;
alter table private.engagement_nudge_events enable row level security;

create index user_engagement_state_due_idx
  on private.user_engagement_state (last_app_active_at, last_post_at, last_nudge_for_at);
create index engagement_nudge_events_pending_idx
  on private.engagement_nudge_events (created_at)
  where status = 'pending';

-- 마지막 게시글을 빠르게 찾고, 삭제된 글은 활동 기준에서 제외한다.
create index if not exists room_posts_author_created_idx
  on public.room_posts (author_id, created_at desc)
  where deleted_at is null
    and kind in ('post'::public.room_post_kind, 'poll'::public.room_post_kind);

-- 기존 사용자는 기능 배포 시각부터 24시간의 유예를 받는다. 새 사용자는
-- 로그인 후 record_app_activity()가 상태 행을 만든다.
insert into private.user_engagement_state (user_id, last_app_active_at, last_post_at)
select
  p.id,
  statement_timestamp(),
  max(rp.created_at) filter (
    where rp.deleted_at is null
      and rp.kind in ('post'::public.room_post_kind, 'poll'::public.room_post_kind)
  )
from public.profiles p
left join public.room_posts rp on rp.author_id = p.id
group by p.id
on conflict (user_id) do nothing;

create trigger user_engagement_state_set_updated_at
before update on private.user_engagement_state
for each row execute function private.set_updated_at();

-- 앱 foreground/heartbeat에서 호출하는 인증 사용자용 RPC 구현.
create or replace function private.record_app_activity_impl()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := statement_timestamp();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  insert into private.user_engagement_state (
    user_id, last_app_active_at, updated_at
  )
  values (v_user_id, v_now, v_now)
  on conflict (user_id) do update
    set last_app_active_at = excluded.last_app_active_at,
        updated_at = excluded.updated_at
    where private.user_engagement_state.last_app_active_at
      < excluded.last_app_active_at - interval '10 minutes';
end;
$$;

create or replace function public.record_app_activity()
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.record_app_activity_impl();
$$;

-- 게시글 작성은 앱 접속이기도 하므로 last_app_active_at도 함께 갱신한다.
-- 공지(notice)는 방장 운영 행위라 개인 게시 활동으로 세지 않는다.
create or replace function private.record_room_post_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_post_at timestamptz;
begin
  if tg_op = 'INSERT' and new.deleted_at is null then
    insert into private.user_engagement_state (
      user_id, last_app_active_at, last_post_at, updated_at
    )
    values (
      new.author_id,
      statement_timestamp(),
      case
        when new.kind in ('post'::public.room_post_kind, 'poll'::public.room_post_kind)
          then new.created_at
        else null
      end,
      statement_timestamp()
    )
    on conflict (user_id) do update
      set last_app_active_at = greatest(
            private.user_engagement_state.last_app_active_at,
            excluded.last_app_active_at
          ),
          last_post_at = case
            when excluded.last_post_at is null then private.user_engagement_state.last_post_at
            else greatest(
              coalesce(private.user_engagement_state.last_post_at, excluded.last_post_at),
              excluded.last_post_at
            )
          end,
          updated_at = statement_timestamp();
  elsif tg_op = 'UPDATE' and old.deleted_at is distinct from new.deleted_at then
    select max(rp.created_at)
      into v_last_post_at
    from public.room_posts rp
    where rp.author_id = old.author_id
      and rp.deleted_at is null
      and rp.kind in ('post'::public.room_post_kind, 'poll'::public.room_post_kind);

    insert into private.user_engagement_state (
      user_id, last_app_active_at, last_post_at, updated_at
    )
    values (old.author_id, statement_timestamp(), v_last_post_at, statement_timestamp())
    on conflict (user_id) do update
      set last_app_active_at = greatest(
            private.user_engagement_state.last_app_active_at,
            excluded.last_app_active_at
          ),
          last_post_at = excluded.last_post_at,
          updated_at = statement_timestamp();
  end if;

  return new;
end;
$$;

drop trigger if exists room_posts_record_engagement on public.room_posts;
create trigger room_posts_record_engagement
after insert or update of deleted_at on public.room_posts
for each row execute function private.record_room_post_engagement();

-- 활성 방, 알림 설정, 활성 Expo 토큰, 한국 시간 quiet hours를 모두 확인한 뒤
-- due 상태를 원자적으로 선점한다. 외부 HTTP 호출은 이 트랜잭션에서 하지 않는다.
create or replace function private.enqueue_due_engagement_nudges(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_local_time time := timezone('Asia/Seoul', statement_timestamp())::time;
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  v_count integer;
begin
  if v_local_time < time '09:00' or v_local_time >= time '21:00' then
    return 0;
  end if;

  with candidates as (
    select
      s.user_id,
      greatest(s.last_app_active_at, coalesce(s.last_post_at, s.last_app_active_at)) as reference_at,
      case
        when s.last_post_at is null
          or s.last_post_at <= v_now - interval '24 hours'
          then 'no_post'
        else 'inactive'
      end as reason
    from private.user_engagement_state s
    join public.profiles p on p.id = s.user_id
    where p.notifications_enabled
      and greatest(s.last_app_active_at, coalesce(s.last_post_at, s.last_app_active_at))
        <= v_now - interval '24 hours'
      and (
        s.last_nudge_for_at is null
        or s.last_nudge_for_at
          < greatest(s.last_app_active_at, coalesce(s.last_post_at, s.last_app_active_at))
      )
      and exists (
        select 1
        from public.room_members rm
        join public.rooms r
          on r.id = rm.room_id
         and r.status = 'open'
        left join public.user_room_preferences pref
          on pref.user_id = rm.user_id
         and pref.room_id = rm.room_id
        where rm.user_id = s.user_id
          and rm.status = 'active'
          and coalesce(pref.notifications_enabled, true)
      )
      and exists (
        select 1
        from public.device_push_tokens t
        where t.user_id = s.user_id
          and t.is_enabled
          and t.token ~ '^ExponentPushToken\[[^]]+\]$'
      )
    order by reference_at asc, s.user_id
    limit v_limit
    for update of s skip locked
  ), claimed as (
    update private.user_engagement_state s
       set last_nudge_for_at = c.reference_at,
           updated_at = v_now
      from candidates c
     where s.user_id = c.user_id
    returning s.user_id
  ), inserted as (
    insert into private.engagement_nudge_events (
      user_id, reason, reference_at
    )
    select c.user_id, c.reason, c.reference_at
    from candidates c
    join claimed x on x.user_id = c.user_id
    on conflict (user_id, reference_at) do nothing
    returning id
  )
  select count(*)::integer into v_count from inserted;

  return coalesce(v_count, 0);
end;
$$;

-- Cron이 호출하는 DB -> Edge Function dispatcher. 기존 방 공지 발송과 같은
-- project secret을 Vault에서 읽고, Git이나 앱에는 노출하지 않는다.
create or replace function private.dispatch_engagement_nudges()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_api_key text;
begin
  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = 'room_notice_push_api_key'
  limit 1;

  if coalesce(v_api_key, '') = '' then
    raise warning 'room notice push API key is not configured';
    return;
  end if;

  perform net.http_post(
    url := 'https://htmzbkpmudldacxgvaxu.supabase.co/functions/v1/deliver-engagement-nudges',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_api_key
    ),
    timeout_milliseconds := 5_000
  );
exception when others then
  raise warning 'engagement nudge dispatch could not be queued: %', sqlerrm;
end;
$$;

create or replace function private.run_engagement_nudge_cycle()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_due_engagement_nudges(500);
  perform private.dispatch_engagement_nudges();
end;
$$;

-- Edge Function이 큐를 동시성 안전하게 가져간다. pending 행만 선점하고
-- 외부 Expo 호출은 함수 밖에서 수행하므로 DB lock을 오래 잡지 않는다.
create or replace function private.claim_engagement_nudge_events_impl(p_limit integer default 100)
returns table (
  id uuid,
  user_id uuid,
  reason text,
  reference_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 1000));
begin
  return query
  with picked as (
    select e.id
    from private.engagement_nudge_events e
    where e.status = 'pending'
    order by e.created_at asc
    limit v_limit
    for update skip locked
  )
  update private.engagement_nudge_events e
     set status = 'claimed',
         claimed_at = statement_timestamp(),
         attempt_count = e.attempt_count + 1
    from picked
   where e.id = picked.id
  returning e.id, e.user_id, e.reason, e.reference_at;
end;
$$;

create or replace function public.claim_engagement_nudge_events(p_limit integer default 100)
returns table (
  id uuid,
  user_id uuid,
  reason text,
  reference_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select * from private.claim_engagement_nudge_events_impl(p_limit);
$$;

create or replace function private.complete_engagement_nudge_event_impl(
  p_event_id uuid,
  p_status text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed') then
    raise exception using errcode = '22023', message = 'invalid engagement nudge status';
  end if;

  update private.engagement_nudge_events
  set status = p_status,
      sent_at = case when p_status = 'sent' then statement_timestamp() else null end,
      last_error = case
        when p_error is null then null
        else left(p_error, 500)
      end
  where id = p_event_id
    and status = 'claimed';
end;
$$;

create or replace function public.complete_engagement_nudge_event(
  p_event_id uuid,
  p_status text,
  p_error text default null
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.complete_engagement_nudge_event_impl(p_event_id, p_status, p_error);
$$;

do $cron_setup$
begin
  if not exists (
    select 1 from cron.job where jobname = 'zaringovy-engagement-nudge-cycle'
  ) then
    perform cron.schedule(
      'zaringovy-engagement-nudge-cycle',
      '*/5 * * * *',
      'select private.run_engagement_nudge_cycle();'
    );
  end if;
end
$cron_setup$;

-- Client-facing RPC는 authenticated만, worker-facing RPC는 service_role만 허용한다.
revoke all on function private.record_app_activity_impl() from public, anon, authenticated, service_role;
revoke all on function private.record_room_post_engagement() from public, anon, authenticated, service_role;
revoke all on function private.enqueue_due_engagement_nudges(integer) from public, anon, authenticated, service_role;
revoke all on function private.dispatch_engagement_nudges() from public, anon, authenticated, service_role;
revoke all on function private.run_engagement_nudge_cycle() from public, anon, authenticated, service_role;
revoke all on function private.claim_engagement_nudge_events_impl(integer) from public, anon, authenticated, service_role;
revoke all on function private.complete_engagement_nudge_event_impl(uuid, text, text) from public, anon, authenticated, service_role;

grant execute on function private.record_app_activity_impl() to authenticated;
grant usage on schema private to service_role;
grant execute on function private.claim_engagement_nudge_events_impl(integer) to service_role;
grant execute on function private.complete_engagement_nudge_event_impl(uuid, text, text) to service_role;

revoke all on function public.record_app_activity() from public, anon, service_role;
revoke all on function public.claim_engagement_nudge_events(integer) from public, anon, authenticated;
revoke all on function public.complete_engagement_nudge_event(uuid, text, text) from public, anon, authenticated;

grant execute on function public.record_app_activity() to authenticated;
grant execute on function public.claim_engagement_nudge_events(integer) to service_role;
grant execute on function public.complete_engagement_nudge_event(uuid, text, text) to service_role;
