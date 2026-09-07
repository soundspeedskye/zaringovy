-- Expo token은 앱 설치/기기 단위라 계정 전환 시 같은 토큰을 현재 세션 계정으로
-- 안전하게 이전해야 한다. 앱 클라이언트는 다른 사용자의 행을 직접 수정하지 않는다.
create function private.claim_device_push_token_impl(
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
  if p_platform <> 'ios'::public.push_platform
    or p_token !~ '^ExponentPushToken\[[^]]+\]$'
    or char_length(p_token) not between 16 and 4096
    or p_device_id !~ '^ios:.+'
    or char_length(p_device_id) > 200 then
    raise exception using errcode = '22023', message = 'invalid push token claim';
  end if;

  -- 같은 앱 설치의 iPhone에는 활성 토큰을 하나만 둔다. 계정을 바꾸거나 토큰이
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

create function public.claim_device_push_token(
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

-- DB webhook은 Vault에 저장한 project secret key로 호출한다. Function은 같은 키를
-- withSupabase({ auth: 'secret' })에서 검증하고 service client를 얻는다.
create or replace function private.dispatch_room_notice_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_secret_key text;
begin
  select decrypted_secret into v_project_secret_key
  from vault.decrypted_secrets
  where name = 'room_notice_push_api_key'
  limit 1;

  if coalesce(v_project_secret_key, '') = '' then
    raise warning 'room notice push API key is not configured';
    return new;
  end if;

  perform net.http_post(
    url := 'https://htmzbkpmudldacxgvaxu.supabase.co/functions/v1/deliver-room-notice-push',
    body := jsonb_build_object('notificationId', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_project_secret_key
    ),
    timeout_milliseconds := 5_000
  );
  return new;
exception when others then
  raise warning 'room notice push dispatch could not be queued: %', sqlerrm;
  return new;
end;
$$;

revoke all on function private.dispatch_room_notice_push() from public, anon, authenticated, service_role;
