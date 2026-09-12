-- FCM registration tokens are app-install credentials, not user credentials.
-- The RPC keeps the same account-transfer behavior while accepting both native
-- platforms and rejecting Expo Push Tokens from the old delivery path.
create or replace function private.claim_device_push_token_impl(
  p_platform public.push_platform,
  p_token text,
  p_device_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_token_row_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_platform is null
    or p_platform not in ('ios'::public.push_platform, 'android'::public.push_platform)
    or p_token is null
    or char_length(p_token) not between 16 and 4096
    or p_token ~ '[[:space:]]'
    or p_token like 'ExponentPushToken[%]'
    or p_device_id is null
    or char_length(p_device_id) > 200
    or p_device_id !~ '^(ios|android):[^[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid push token claim';
  end if;

  -- 같은 앱 설치에는 활성 토큰을 하나만 둔다. 계정을 바꾸거나 토큰이
  -- 재발급되면 이전 계정에 남은 토큰도 제거해 오발송을 막는다.
  delete from public.device_push_tokens
  where platform = p_platform
    and device_id = p_device_id
    and token <> p_token;

  select id into v_token_row_id
  from public.device_push_tokens
  where token = p_token
  for update;

  if v_token_row_id is null then
    insert into public.device_push_tokens (user_id, platform, token, device_id, is_enabled, last_seen_at)
    values (v_user_id, p_platform, p_token, p_device_id, true, statement_timestamp());
  else
    update public.device_push_tokens
    set user_id = v_user_id,
        platform = p_platform,
        device_id = p_device_id,
        is_enabled = true,
        last_seen_at = statement_timestamp()
    where id = v_token_row_id;
  end if;
end;
$$;

create or replace function public.claim_device_push_token(
  p_platform public.push_platform,
  p_token text,
  p_device_id text
)
returns void
language sql
security definer
set search_path = ''
as $$ select private.claim_device_push_token_impl(p_platform, p_token, p_device_id); $$;

revoke all on function private.claim_device_push_token_impl(public.push_platform, text, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_device_push_token(public.push_platform, text, text) from public, anon, service_role;
grant execute on function public.claim_device_push_token(public.push_platform, text, text) to authenticated;

-- FCM 토큰을 가진 사용자만 리마인더 큐의 후보가 되도록 기존 함수의
-- Expo Push Token 조건을 직접 FCM 조건으로 교체한다.
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
          and t.platform in ('ios'::public.push_platform, 'android'::public.push_platform)
          and char_length(t.token) between 16 and 4096
          and t.token not like 'ExponentPushToken[%]'
          and t.token !~ '[[:space:]]'
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
