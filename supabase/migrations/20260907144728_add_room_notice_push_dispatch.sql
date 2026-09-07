-- 공지 작성 RPC가 만든 각 수신자별 소식함 행을 비동기 webhook으로 전달한다.
-- 웹훅 비밀값은 Git이 아닌 Supabase Vault에만 저장한다.
create extension if not exists pg_net with schema extensions;

create function private.dispatch_room_notice_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_webhook_secret text;
begin
  select decrypted_secret into v_webhook_secret
  from vault.decrypted_secrets
  where name = 'room_notice_push_webhook_secret'
  limit 1;

  if coalesce(v_webhook_secret, '') = '' then
    raise warning 'room notice push webhook secret is not configured';
    return new;
  end if;

  perform net.http_post(
    url := 'https://htmzbkpmudldacxgvaxu.supabase.co/functions/v1/deliver-room-notice-push',
    body := jsonb_build_object('notificationId', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-room-notice-push-secret', v_webhook_secret
    ),
    timeout_milliseconds := 5_000
  );
  return new;
exception when others then
  -- 외부 전달 문제가 공지 작성·소식함 저장을 되돌리면 안 된다.
  raise warning 'room notice push dispatch could not be queued: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists notifications_dispatch_room_notice_push on public.notifications;
create trigger notifications_dispatch_room_notice_push
after insert on public.notifications
for each row
when (new.kind = 'room_notice')
execute function private.dispatch_room_notice_push();

revoke all on function private.dispatch_room_notice_push() from public, anon, authenticated, service_role;
