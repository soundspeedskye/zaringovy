-- 같은 방 안 닉네임 중복 규칙의 데이터베이스 테스트.
--
-- 실행:
--   supabase db reset
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/nickname_uniqueness_test.sql
--
-- 전체가 한 트랜잭션이고 끝에서 롤백하므로 로컬 데이터베이스에 흔적을 남기지
-- 않는다. 실패는 예외로 즉시 멈춘다.
--
-- 이 스크립트는 postgres 역할로 돌지만, 판정에 쓰이는 것은 역할이 아니라
-- request.jwt.claims의 sub(=auth.uid())다. 쓰기 게이트도 그 값을 본다.

begin;

set local client_min_messages = warning;

--------------------------------------------------------------------------------
-- 도우미
--------------------------------------------------------------------------------

create function pg_temp.act_as(p_user_id uuid)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
    true
  );
  select null::void;
$$;

create function pg_temp.expect(p_ok boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;

-- 주어진 문장이 기대한 메시지로 실패하는지 본다. 성공해버리거나 다른 이유로
-- 실패하면 둘 다 회귀다.
create function pg_temp.expect_raises(p_sql text, p_message text, p_label text)
returns void
language plpgsql
as $$
declare
  v_error text;
begin
  begin
    execute p_sql;
    raise exception 'FAIL: % (거절되지 않았다)', p_label;
  exception
    when others then
      v_error := sqlerrm;
      if v_error like 'FAIL:%' then
        raise;
      end if;
      if position(p_message in v_error) = 0 then
        raise exception 'FAIL: % (기대: %, 실제: %)', p_label, p_message, v_error;
      end if;
  end;
  raise notice 'ok - %', p_label;
end;
$$;

create function pg_temp.blocked(p_room_id uuid, p_user_id uuid)
returns boolean
language sql
as $$
  select coalesce(
    (
      select m.nickname_change_required
      from public.room_members m
      where m.room_id = p_room_id and m.user_id = p_user_id
    ),
    false
  );
$$;

--------------------------------------------------------------------------------
-- 픽스처
--------------------------------------------------------------------------------

-- 방 A: 방장 '아르민' + 나중에 들어올 '아르민'(중복) + '스카이'
-- 방 B: 방장 '보리'. 방 A와 같은 닉네임이 살아도 되는지 확인하는 데 쓴다.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'owner-a@test.local',  '{"nickname":"아르민"}'),
  ('22222222-2222-4222-8222-222222222222', 'late-a@test.local',   '{"nickname":"아르민"}'),
  ('33333333-3333-4333-8333-333333333333', 'third-a@test.local',  '{"nickname":"스카이"}'),
  ('44444444-4444-4444-8444-444444444444', 'owner-b@test.local',  '{"nickname":"보리"}'),
  ('55555555-5555-4555-8555-555555555555', 'member-b@test.local', '{"nickname":"파랑"}');

insert into public.rooms (id, name, creator_id, owner_id, base_amount, capacity, client_request_id)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '방 A',
   '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   50000, 10, gen_random_uuid()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '방 B',
   '44444444-4444-4444-8444-444444444444', '44444444-4444-4444-8444-444444444444',
   50000, 10, gen_random_uuid());

insert into public.room_members (room_id, user_id, role, status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner', 'active'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '44444444-4444-4444-8444-444444444444', 'owner', 'active'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', 'member', 'active');

insert into public.invite_codes (room_id, code, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'AAA234', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'BBB234', '44444444-4444-4444-8444-444444444444');

--------------------------------------------------------------------------------
-- 1. 다른 방의 같은 닉네임은 허용한다
--------------------------------------------------------------------------------

-- 방 B의 '파랑'이 방 A의 방장과 같은 '아르민'으로 바꾼다. 두 사람은 방을 함께
-- 쓰지 않으므로 헷갈릴 일이 없다.
select pg_temp.act_as('55555555-5555-4555-8555-555555555555');
select public.update_my_nickname('아르민');
select pg_temp.expect(
  (select nickname from public.profiles where id = '55555555-5555-4555-8555-555555555555') = '아르민',
  '다른 방의 같은 닉네임은 허용한다'
);

--------------------------------------------------------------------------------
-- 2. 같은 방 안 중복은 일반 변경에서 거절한다
--------------------------------------------------------------------------------

-- 방 A에 '스카이'로 들어온다. 겹치지 않으므로 표시 없이 참여한다.
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select pg_temp.expect(
  (private.join_room_impl('AAA234') ->> 'ok')::boolean,
  '겹치지 않는 닉네임은 그대로 참여한다'
);
select pg_temp.expect(
  not pg_temp.blocked('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333'),
  '겹치지 않으면 닉네임 변경을 요구하지 않는다'
);

-- 같은 방의 방장이 이미 쓰는 이름으로 바꾸려 한다.
select pg_temp.expect_raises(
  $$select public.update_my_nickname('아르민')$$,
  'ROOM_NICKNAME_TAKEN',
  '같은 방의 중복 닉네임으로는 바꿀 수 없다'
);

-- 대소문자·앞뒤 공백·유니코드 조합 차이로 규칙을 피할 수 없다.
select pg_temp.expect_raises(
  $$select public.update_my_nickname('  아르민  ')$$,
  'ROOM_NICKNAME_TAKEN',
  '공백만 다른 이름도 중복으로 본다'
);

--------------------------------------------------------------------------------
-- 3. 중복 닉네임으로 참여하면 나중에 들어온 쪽만 표시된다
--------------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select pg_temp.expect(
  (private.join_room_impl('AAA234') ->> 'ok')::boolean,
  '중복 닉네임이어도 입장 자체는 막지 않는다'
);
select pg_temp.expect(
  pg_temp.blocked('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222'),
  '나중에 참여한 사용자에게 닉네임 변경을 요구한다'
);
select pg_temp.expect(
  not pg_temp.blocked('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111'),
  '먼저 참여한 사용자는 그대로 둔다'
);

--------------------------------------------------------------------------------
-- 4. 표시된 사용자의 참여성 쓰기는 서버가 막는다
--------------------------------------------------------------------------------

-- 방장이 먼저 글 하나를 남겨, 댓글·반응 대상을 만든다.
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
create temporary table gate_fixture as
select public.add_room_post(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'post', 'chat', null, '방장 글',
  null, null, null, null, null, gen_random_uuid()
) as post;

-- 이후 지출 게이트에 쓸 최소 주차. 계산 조건은 이 테스트의 관심사가 아니다.
insert into public.holiday_calendar_versions (
  id, source_name, coverage_start, coverage_end, published_at, is_current
) values (
  'test-nickname-gate', '테스트 픽스처',
  date '2099-01-01', date '2099-12-31', statement_timestamp(), false
) on conflict (id) do nothing;

insert into public.periods (
  id, room_id, week_index, week_start, week_end,
  starts_at, ends_at, correction_ends_at, finalizes_at,
  selected_day_count, valid_day_count, holiday_version_id
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1,
  date '2099-01-05', date '2099-01-09',
  timestamptz '2099-01-05 00:00+09', timestamptz '2099-01-10 00:00+09',
  timestamptz '2099-01-10 12:00+09', timestamptz '2099-01-12 00:00+09',
  5, 5, 'test-nickname-gate'
);

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select pg_temp.expect_raises(
  $$select public.add_room_post(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'post', 'chat', null, '막힌 사용자의 글',
      null, null, null, null, null, gen_random_uuid())$$,
  'NICKNAME_CHANGE_REQUIRED',
  '글 작성을 막는다'
);

select pg_temp.expect_raises(
  format(
    $$select public.add_room_post_comment(%L, '막힌 사용자의 댓글', null, %L)$$,
    (select (post).id from gate_fixture), gen_random_uuid()
  ),
  'NICKNAME_CHANGE_REQUIRED',
  '댓글 작성을 막는다'
);

select pg_temp.expect_raises(
  format(
    $$select public.toggle_room_post_reaction(%L, '👍')$$,
    (select (post).id from gate_fixture)
  ),
  'NICKNAME_CHANGE_REQUIRED',
  '반응을 막는다'
);

-- 지출은 RPC가 주차 참여·기간 조건을 먼저 보므로, 테이블에 직접 넣어 게이트
-- 자체를 확인한다. RPC를 우회해도 막힌다는 뜻이기도 하다.
select pg_temp.expect_raises(
  $$insert into public.expenses (
      period_id, user_id, amount, category, occurred_at,
      photo_path, photo_uploaded_at, client_request_id
    ) values (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222',
      10000, 'lunch', timestamptz '2099-01-06 12:00+09',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc/22222222-2222-4222-8222-222222222222/gate.jpg',
      statement_timestamp(), gen_random_uuid()
    )$$,
  'NICKNAME_CHANGE_REQUIRED',
  '지출 등록을 막는다'
);

--------------------------------------------------------------------------------
-- 5. 읽기와 나가기는 그대로 열려 있다
--------------------------------------------------------------------------------

select pg_temp.expect(
  (select count(*) from public.room_posts
   where room_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1,
  '막힌 상태에서도 방 글을 읽을 수 있다'
);

--------------------------------------------------------------------------------
-- 6. 7일 제한과 필수 변경
--------------------------------------------------------------------------------

-- 방금 이름을 바꾼 것처럼 만들어 제한을 건다.
update public.profiles
set nickname_changed_at = statement_timestamp()
where id = '22222222-2222-4222-8222-222222222222';

-- 새 이름도 같은 방에서 겹치면 필수 변경이라도 거절이다.
select pg_temp.expect_raises(
  $$select public.update_my_nickname('스카이')$$,
  'ROOM_NICKNAME_TAKEN',
  '새 닉네임도 중복이면 거절한다'
);

-- 필수 변경은 7일 제한을 넘어선다.
select public.update_my_nickname('아르민2');
select pg_temp.expect(
  (select nickname from public.profiles where id = '22222222-2222-4222-8222-222222222222') = '아르민2',
  '7일 제한 중이어도 필수 변경은 성공한다'
);
select pg_temp.expect(
  not pg_temp.blocked('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222'),
  '변경에 성공하면 표시를 지운다'
);

-- 표시가 지워졌으니 다시 평범한 멤버다. 쓰기가 열리고 7일 제한이 돌아온다.
select pg_temp.expect(
  (public.add_room_post(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'post', 'chat', null, '이제 쓸 수 있다',
    null, null, null, null, null, gen_random_uuid())).id is not null,
  '표시가 풀리면 다시 글을 쓸 수 있다'
);
select pg_temp.expect_raises(
  $$select public.update_my_nickname('아르민3')$$,
  'NICKNAME_COOLDOWN',
  '변경 뒤에는 다시 7일 제한이 걸린다'
);

--------------------------------------------------------------------------------
-- 7. 나가기는 막지 않는다
--------------------------------------------------------------------------------

-- 다시 막힌 상태를 만든 뒤 나가기를 시도한다.
update public.room_members
set nickname_change_required = true
where room_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and user_id = '22222222-2222-4222-8222-222222222222';

select pg_temp.expect(
  (private.leave_room_impl('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null)).status = 'left',
  '막힌 상태에서도 방을 나갈 수 있다'
);

--------------------------------------------------------------------------------
-- 8. 방장이 이름을 바꾸면 뒤따라 들어온 사람의 표시는 그대로다
--------------------------------------------------------------------------------

-- 아직 남아 있는 '스카이'는 겹친 적이 없으니 계속 자유롭게 바꿀 수 있다.
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select public.update_my_nickname('스카이2');
select pg_temp.expect(
  (select nickname from public.profiles where id = '33333333-3333-4333-8333-333333333333') = '스카이2',
  '겹치지 않는 이름으로는 평소처럼 바꾼다'
);

do $$
begin
  raise notice '모든 검사를 통과했습니다.';
end;
$$;

rollback;
