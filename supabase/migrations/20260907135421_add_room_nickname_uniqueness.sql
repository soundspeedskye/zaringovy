-- 같은 방 안에서만 닉네임 중복을 막는다.
--
-- 닉네임은 여전히 전역으로 중복될 수 있다. 방의 글·댓글·지출은 닉네임으로만
-- 구분되므로, 한 방 안에 같은 이름이 둘 있으면 누가 썼는지 읽을 수 없다.
-- 서로 다른 방이라면 섞일 일이 없으니 그대로 허용한다.
--
-- 정책은 두 갈래다.
--   1) 닉네임 변경: 내가 속한 방의 다른 활성 멤버와 겹치면 거절한다.
--   2) 방 참여/이동: 입장은 막지 않는다. 대신 나중에 들어온 쪽에
--      room_members.nickname_change_required를 세워, 이름을 바꾸기 전까지
--      그 방에서 참여성 쓰기를 할 수 없게 한다. 읽기와 나가기는 그대로다.
--
-- 상태를 멤버십 행에 두는 이유: 차단은 "그 방에서만" 성립하고 앱 재시작·기기
-- 교체와 무관하게 유지돼야 한다. 프로필에 두면 방을 옮겨도 따라다니고,
-- 클라이언트에 두면 앱을 지웠다 깔면 사라진다.

alter table public.room_members
  add column if not exists nickname_change_required boolean not null default false;

comment on column public.room_members.nickname_change_required is
  '먼저 참여한 같은 닉네임의 활성 멤버가 있어 닉네임을 바꿔야 이 방에서 활동할 수 있는 상태.';

-- 라우팅 가드와 쓰기 게이트가 매번 "내가 지금 막혀 있나"를 묻는다.
create index if not exists room_members_nickname_block_idx
  on public.room_members (user_id, room_id)
  where nickname_change_required and status = 'active';

--------------------------------------------------------------------------------
-- 1. 닉네임 비교 규칙
--------------------------------------------------------------------------------

-- 사람 눈에 같아 보이는 이름은 같은 이름으로 친다. 한글은 자모 조합이 두 가지로
-- 인코딩될 수 있어(NFC/NFD) 정규화가 없으면 '아르민'과 '아르민'이 다른 값이 된다.
-- 대소문자와 앞뒤 공백도 구분하지 않는다.
create or replace function private.normalized_nickname(p_nickname text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(normalize(btrim(coalesce(p_nickname, '')), nfc));
$$;

-- 이 방의 다른 활성 멤버가 이미 쓰고 있는 닉네임인가.
create or replace function private.room_nickname_taken(
  p_room_id uuid,
  p_user_id uuid,
  p_nickname text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members m
    join public.profiles p on p.id = m.user_id
    where m.room_id = p_room_id
      and m.status = 'active'
      and m.user_id is distinct from p_user_id
      and private.normalized_nickname(p.nickname)
          = private.normalized_nickname(p_nickname)
  );
$$;

-- 지금 이 사용자가 이 방에서 닉네임을 바꿔야 하는 상태인가.
create or replace function private.needs_nickname_change(
  p_room_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
    from public.room_members m
    where m.room_id = p_room_id
      and m.user_id = p_user_id
      and m.status = 'active'
      and m.nickname_change_required
  );
$$;

--------------------------------------------------------------------------------
-- 2. 쓰기 게이트
--------------------------------------------------------------------------------

-- 참여성 쓰기 테이블은 RLS에 write 정책이 없고 authenticated에 insert/update
-- 권한도 없다. 모든 쓰기는 security definer RPC를 지난다. 그래서 게이트를 RPC
-- 하나하나에 넣으면 새 RPC가 생길 때마다 빠뜨릴 구멍이 생긴다.
-- 트리거는 security definer 안에서도 그대로 돌기 때문에, 여기 한 곳에 두면
-- 지금 있는 RPC든 앞으로 생길 RPC든 우회할 수 없다.
--
-- 판단 기준은 행의 소유자가 아니라 "지금 요청을 보낸 사람"(auth.uid())이다.
-- 남의 행을 건드리는 RPC(예외 승인 등)까지 함께 막힌다. cron·정산·계정 삭제는
-- service_role이나 postgres로 도는 데다 auth.uid()가 없어 영향을 받지 않는다.
create or replace function private.room_write_blocked(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.needs_nickname_change(p_room_id, (select auth.uid()));
$$;

-- 참여성 테이블마다 방을 찾아가는 경로가 다르다. 경로 종류와 열 이름을 트리거
-- 인자로 받아, 함수 하나로 전부 처리한다.
create or replace function private.enforce_room_nickname_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_key uuid;
  v_room_id uuid;
begin
  -- 인증된 요청이 아니면(cron·정산·계정 삭제) 게이트 대상이 아니다.
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;
  v_key := nullif(v_row ->> tg_argv[1], '')::uuid;

  -- 방에 속하지 않은 행(개인 지출 등)은 방 정책의 대상이 아니다.
  if v_key is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  case tg_argv[0]
    when 'room' then
      v_room_id := v_key;
    when 'period' then
      select p.room_id into v_room_id
      from public.periods p
      where p.id = v_key;
    when 'expense' then
      select p.room_id into v_room_id
      from public.expenses e
      join public.periods p on p.id = e.period_id
      where e.id = v_key;
    when 'comment' then
      select p.room_id into v_room_id
      from public.comments c
      join public.expenses e on e.id = c.expense_id
      join public.periods p on p.id = e.period_id
      where c.id = v_key;
    when 'post' then
      select rp.room_id into v_room_id
      from public.room_posts rp
      where rp.id = v_key;
    else
      raise exception using
        errcode = '22023',
        message = 'unknown nickname gate target: ' || tg_argv[0];
  end case;

  if v_room_id is not null and private.room_write_blocked(v_room_id) then
    raise exception using
      errcode = '42501',
      message = 'NICKNAME_CHANGE_REQUIRED';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists expenses_nickname_gate on public.expenses;
create trigger expenses_nickname_gate
before insert or update or delete on public.expenses
for each row execute function private.enforce_room_nickname_gate('period', 'period_id');

drop trigger if exists comments_nickname_gate on public.comments;
create trigger comments_nickname_gate
before insert or update or delete on public.comments
for each row execute function private.enforce_room_nickname_gate('expense', 'expense_id');

drop trigger if exists comment_reactions_nickname_gate on public.comment_reactions;
create trigger comment_reactions_nickname_gate
before insert or update or delete on public.comment_reactions
for each row execute function private.enforce_room_nickname_gate('comment', 'comment_id');

drop trigger if exists comment_mentions_nickname_gate on public.comment_mentions;
create trigger comment_mentions_nickname_gate
before insert or update or delete on public.comment_mentions
for each row execute function private.enforce_room_nickname_gate('comment', 'comment_id');

drop trigger if exists expense_exceptions_nickname_gate on public.expense_exceptions;
create trigger expense_exceptions_nickname_gate
before insert or update or delete on public.expense_exceptions
for each row execute function private.enforce_room_nickname_gate('expense', 'expense_id');

drop trigger if exists expense_exception_approvals_nickname_gate
  on public.expense_exception_approvals;
create trigger expense_exception_approvals_nickname_gate
before insert or update or delete on public.expense_exception_approvals
for each row execute function private.enforce_room_nickname_gate('expense', 'expense_id');

drop trigger if exists room_posts_nickname_gate on public.room_posts;
create trigger room_posts_nickname_gate
before insert or update or delete on public.room_posts
for each row execute function private.enforce_room_nickname_gate('room', 'room_id');

drop trigger if exists room_post_comments_nickname_gate on public.room_post_comments;
create trigger room_post_comments_nickname_gate
before insert or update or delete on public.room_post_comments
for each row execute function private.enforce_room_nickname_gate('post', 'post_id');

drop trigger if exists room_post_reactions_nickname_gate on public.room_post_reactions;
create trigger room_post_reactions_nickname_gate
before insert or update or delete on public.room_post_reactions
for each row execute function private.enforce_room_nickname_gate('post', 'post_id');

drop trigger if exists room_post_poll_options_nickname_gate on public.room_post_poll_options;
create trigger room_post_poll_options_nickname_gate
before insert or update or delete on public.room_post_poll_options
for each row execute function private.enforce_room_nickname_gate('post', 'post_id');

drop trigger if exists room_post_poll_votes_nickname_gate on public.room_post_poll_votes;
create trigger room_post_poll_votes_nickname_gate
before insert or update or delete on public.room_post_poll_votes
for each row execute function private.enforce_room_nickname_gate('post', 'post_id');

-- 지출 사진 업로드는 테이블이 아니라 storage.objects의 insert/update 정책이
-- 판정하므로 위 트리거가 닿지 않는다. 그 정책이 쓰는 활성 주차 멤버 판정에
-- 차단 상태를 함께 넣어, 사진만 먼저 올려두는 우회를 막는다. 이 함수는 예외
-- 신청·응답 RPC의 가드이기도 해서 그쪽도 같이 막힌다. 읽기 정책은 별도의
-- is_period_room_member를 쓰므로 열람에는 영향이 없다.
create or replace function private.is_active_period_member(
  p_period_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
    from public.period_members pm
    join public.periods p on p.id = pm.period_id
    join public.room_members m
      on m.room_id = p.room_id
     and m.user_id = pm.user_id
    where pm.period_id = p_period_id
      and pm.user_id = p_user_id
      and pm.status = 'active'
      and not m.nickname_change_required
  );
$$;

--------------------------------------------------------------------------------
-- 3. 방 참여: 나중에 들어온 쪽에만 표시한다
--------------------------------------------------------------------------------

-- 원본과 다른 곳은 두 군데뿐이다.
--   - 참여 직전에 같은 닉네임의 활성 멤버가 있는지 본다.
--   - 있으면 새 멤버 행에 nickname_change_required를 세운다.
-- 이 함수는 위에서 이미 대상 방을 for update로 잠근 뒤에 검사한다. 같은 방에
-- 동시에 들어오는 두 사람은 그 잠금에서 줄을 서므로, 먼저 커밋한 쪽이 "먼저
-- 참여한 멤버"가 되고 뒤에 온 쪽만 표시된다. 방을 옮기는 switch_room도 이
-- 함수를 그대로 호출해 같은 규칙을 받는다.
create or replace function private.join_room_impl(p_invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := left(upper(btrim(coalesce(p_invite_code, ''))), 32);
  v_invite public.invite_codes%rowtype;
  v_room public.rooms%rowtype;
  v_existing public.room_members%rowtype;
  v_member public.room_members%rowtype;
  v_period public.periods%rowtype;
  v_period_member public.period_members%rowtype;
  v_today date := timezone('Asia/Seoul', now())::date;
  v_member_count integer;
  v_nickname text;
  v_nickname_taken boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if private.invite_lookup_is_rate_limited(v_user_id) then
    return jsonb_build_object('ok', false, 'error_code', 'RATE_LIMITED');
  end if;

  if v_code !~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$' then
    insert into private.invite_code_attempts (user_id, normalized_code, was_successful)
    values (v_user_id, v_code, false);
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_CODE');
  end if;

  select i.* into v_invite
  from public.invite_codes i
  where i.code = v_code
    and i.is_active
  for update;

  if v_invite.id is null
     or (v_invite.expires_at is not null and v_invite.expires_at <= now()) then
    insert into private.invite_code_attempts (user_id, normalized_code, was_successful)
    values (v_user_id, v_code, false);
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_CODE');
  end if;

  select r.* into strict v_room
  from public.rooms r
  where r.id = v_invite.room_id
  for update;

  if v_room.status = 'closed' then
    insert into private.invite_code_attempts (user_id, normalized_code, was_successful)
    values (v_user_id, v_code, false);
    return jsonb_build_object('ok', false, 'error_code', 'ROOM_CLOSED');
  end if;

  select m.* into v_existing
  from public.room_members m
  where m.room_id = v_room.id
    and m.user_id = v_user_id;

  if v_existing.user_id is not null then
    if v_existing.status = 'active' then
      select pm.* into v_period_member
      from public.period_members pm
      join public.periods p on p.id = pm.period_id
      where p.room_id = v_room.id
        and pm.user_id = v_user_id
        and statement_timestamp() < p.ends_at
      order by p.week_start desc
      limit 1;
      return jsonb_build_object(
        'ok', true,
        'member', to_jsonb(v_existing),
        'period_member', to_jsonb(v_period_member),
        'idempotent', true
      );
    end if;
    return jsonb_build_object('ok', false, 'error_code', 'ALREADY_PARTICIPATED');
  end if;

  select count(*)::integer into v_member_count
  from public.room_members m
  where m.room_id = v_room.id
    and m.status = 'active';
  if v_member_count >= v_room.capacity then
    insert into private.invite_code_attempts (user_id, normalized_code, was_successful)
    values (v_user_id, v_code, true);
    return jsonb_build_object('ok', false, 'error_code', 'CAPACITY_FULL');
  end if;

  insert into public.profiles (id, nickname)
  values (v_user_id, '사용자')
  on conflict (id) do nothing;

  -- 정원 확인까지 통과한 뒤에 본다. 들어올 수 없는 사람에게 이름 변경을
  -- 요구할 이유가 없다.
  select p.nickname into v_nickname
  from public.profiles p
  where p.id = v_user_id;
  v_nickname_taken := private.room_nickname_taken(v_room.id, v_user_id, v_nickname);

  insert into public.room_members (room_id, user_id, role, status, nickname_change_required)
  values (v_room.id, v_user_id, 'member', 'active', v_nickname_taken)
  returning * into v_member;

  select p.* into v_period
  from public.periods p
  where p.room_id = v_room.id
    and statement_timestamp() < p.ends_at
  order by p.week_start desc
  limit 1;

  if v_period.id is not null then
    v_period_member := private.upsert_period_member(v_period.id, v_user_id, v_today);
  end if;

  insert into private.invite_code_attempts (user_id, normalized_code, was_successful)
  values (v_user_id, v_code, true);

  perform private.enqueue_notification(
    recipient.user_id,
    'member_joined',
    v_user_id,
    v_room.id,
    v_period.id,
    null,
    null,
    '/rooms/' || v_room.id::text || '/members',
    'member_joined:' || v_room.id::text || ':' || v_user_id::text
  )
  from public.room_members recipient
  where recipient.room_id = v_room.id
    and recipient.status = 'active'
    and recipient.user_id <> v_user_id;

  if v_member_count + 1 = v_room.capacity then
    perform private.enqueue_notification(
      v_room.owner_id,
      'capacity_full',
      v_user_id,
      v_room.id,
      null,
      null,
      null,
      '/rooms/' || v_room.id::text || '/members',
      'capacity_full:' || v_room.id::text
    );
  end if;

  perform private.write_audit_event(
    v_user_id,
    'room.joined',
    'room',
    v_room.id,
    jsonb_build_object(
      'joined_on', v_today,
      'period_id', v_period.id,
      'eligible_day_count', v_period_member.eligible_day_count,
      'applied_limit', v_period_member.applied_limit,
      'nickname_change_required', v_nickname_taken
    )
  );

  return jsonb_build_object(
    'ok', true,
    'member', to_jsonb(v_member),
    'period_member', to_jsonb(v_period_member),
    'idempotent', false
  );
end;
$$;

--------------------------------------------------------------------------------
-- 4. 닉네임 변경
--------------------------------------------------------------------------------

-- 7일 제한은 그대로 둔다. 예외는 "중복 때문에 막혀 있는 사람"뿐이고, 그 판단은
-- 서버가 room_members를 직접 읽어서 한다. 클라이언트가 보낸 플래그를 믿으면
-- 누구나 예외를 자칭해 제한을 무력화할 수 있다.
create or replace function public.update_my_nickname(p_nickname text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_last_changed_at timestamptz;
  v_change_required boolean;
  v_room_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if char_length(v_nickname) not between 2 and 20 or v_nickname !~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'INVALID_NICKNAME';
  end if;

  -- 내가 속한 방들을 잠근다. join_room_impl도 같은 방 행을 for update로 잡으므로,
  -- "같은 이름으로 동시에 들어오기"와 "같은 이름으로 동시에 바꾸기"가 모두 이
  -- 잠금에서 직렬화된다. id 순으로 잠가 교착을 피한다.
  for v_room_id in
    select m.room_id
    from public.room_members m
    where m.user_id = v_user_id
      and m.status = 'active'
    order by m.room_id
  loop
    perform 1 from public.rooms r where r.id = v_room_id for update;
  end loop;

  select exists (
    select 1
    from public.room_members m
    where m.user_id = v_user_id
      and m.status = 'active'
      and m.nickname_change_required
  ) into v_change_required;

  select nickname_changed_at into v_last_changed_at
  from public.profiles
  where id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  end if;

  if not v_change_required
    and v_last_changed_at is not null
    and statement_timestamp() < v_last_changed_at + interval '7 days' then
    raise exception using
      errcode = 'P0001',
      message = 'NICKNAME_COOLDOWN',
      detail = (v_last_changed_at + interval '7 days')::text;
  end if;

  -- 필수 변경으로 들어온 경우에도 똑같이 본다. 새 이름이 또 겹치면 거절이다.
  if exists (
    select 1
    from public.room_members mine
    where mine.user_id = v_user_id
      and mine.status = 'active'
      and private.room_nickname_taken(mine.room_id, v_user_id, v_nickname)
  ) then
    raise exception using errcode = 'P0001', message = 'ROOM_NICKNAME_TAKEN';
  end if;

  update public.profiles
  set nickname = v_nickname,
      nickname_changed_at = statement_timestamp()
  where id = v_user_id
    and nickname is distinct from v_nickname;

  -- 위 검사가 내 활성 방 전부에서 중복이 없음을 확인한 뒤다. 이 시점부터는
  -- 다시 평범한 멤버이고, 7일 제한도 방금 찍힌 시각부터 다시 걸린다.
  update public.room_members
  set nickname_change_required = false
  where user_id = v_user_id
    and status = 'active'
    and nickname_change_required;
end;
$$;

--------------------------------------------------------------------------------
-- 5. 권한
--------------------------------------------------------------------------------

-- 판정 함수는 정책·트리거·RPC 안에서만 쓰인다. 클라이언트가 직접 부를 일은 없다.
revoke execute on function private.normalized_nickname(text) from public, anon;
revoke execute on function private.room_nickname_taken(uuid, uuid, text) from public, anon;
revoke execute on function private.needs_nickname_change(uuid, uuid) from public, anon;
revoke execute on function private.room_write_blocked(uuid) from public, anon;
