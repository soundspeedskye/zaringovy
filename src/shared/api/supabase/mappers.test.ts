import { describe, expect, it } from 'vitest';

import { ANIMAL_AVATARS } from '@/shared/config/animals';
import {
  asLocalDate,
  defaultAvatar,
  expenseThumbnailPath,
  hash32,
  mapComment,
  mapCommentReaction,
  mapExpense,
  mapExpenseException,
  mapExpenseExceptionResponse,
  mapInvitePreview,
  mapMemberStatus,
  mapNotification,
  mapPeriod,
  mapPeriodMember,
  mapPeriodResult,
  mapPhase,
  mapProfile,
  mapRoom,
  mapRoomMember,
  mapRoomPost,
  mapRoomPostComment,
  mapRoomPostPollOption,
  mapRoomPostPollVote,
  mapRoomPostReaction,
  mapStats,
  requiredString,
  safeNumber,
  safeSignedNumber,
} from './mappers';
import { asObject } from './json';
import type {
  CommentRow,
  ExpenseRow,
  NotificationRow,
  PeriodMemberRow,
  PeriodResultRow,
  PeriodStatusRow,
  ProfileRow,
  RoomMemberRow,
  RoomPostCommentRow,
  RoomPostRow,
  RoomRow,
} from './rows';

/**
 * 매퍼는 DB 행을 앱 타입으로 옮기는 순수 함수다. 필드를 빠뜨리거나 잘못
 * 연결해도 타입은 통과하고 화면에서만 티가 나므로, 객체 전체를 toEqual로
 * 비교해 누락을 잡는다.
 */

const NO_URLS = new Map<string, string>();

describe('값 헬퍼', () => {
  it('safeNumber는 숫자 문자열을 정수로 받아들인다', () => {
    expect(safeNumber(50_000, '금액')).toBe(50_000);
    // Postgres numeric은 문자열로 내려오는 경우가 있다.
    expect(safeNumber('50000', '금액')).toBe(50_000);
  });

  it('safeNumber는 정수가 아니면 거부한다', () => {
    expect(() => safeNumber(1.5, '지출 금액')).toThrow('지출 금액 응답이 올바르지 않아요.');
    expect(() => safeNumber('abc', '지출 금액')).toThrow('지출 금액 응답이 올바르지 않아요.');
    expect(() => safeNumber(null, '지출 금액')).toThrow('지출 금액 응답이 올바르지 않아요.');
  });

  it('safeSignedNumber는 음수를 허용한다', () => {
    // 한도를 넘게 쓰면 잔액이 음수가 된다.
    expect(safeSignedNumber(-3_000, '잔액')).toBe(-3_000);
  });

  it('requiredString은 빈 문자열을 거부한다', () => {
    expect(requiredString('room-1', '방 ID')).toBe('room-1');
    expect(() => requiredString('', '방 ID')).toThrow('방 ID 응답이 올바르지 않아요.');
    expect(() => requiredString(42, '방 ID')).toThrow('방 ID 응답이 올바르지 않아요.');
  });

  it('asLocalDate는 YYYY-MM-DD만 통과시킨다', () => {
    expect(asLocalDate('2026-08-03')).toBe('2026-08-03');
    expect(() => asLocalDate('2026/08/03')).toThrow('날짜 응답 형식이 올바르지 않아요.');
    expect(() => asLocalDate('2026-08-03T00:00:00Z')).toThrow();
  });

  it('asObject는 객체만 통과시킨다', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject([1, 2])).toBeNull();
    expect(asObject(null)).toBeNull();
    expect(asObject('x')).toBeNull();
  });

  it('hash32는 같은 입력에 같은 값을 준다', () => {
    expect(hash32('user-a')).toBe(hash32('user-a'));
    expect(hash32('user-a')).not.toBe(hash32('user-b'));
  });

  it('defaultAvatar는 결정론적으로 동물 하나를 고른다', () => {
    const avatar = defaultAvatar('user-a');
    expect(ANIMAL_AVATARS).toContain(avatar);
    expect(defaultAvatar('user-a')).toBe(avatar);
  });
});

describe('mapProfile', () => {
  const row: ProfileRow = {
    id: 'user-a',
    nickname: '스카이',
    avatar_key: 'fox',
    avatar_path: 'avatars/a.jpg',
    nickname_changed_at: '2026-08-01T00:00:00.000Z',
  };

  it('행을 프로필로 옮긴다', () => {
    expect(mapProfile(row, new Map([['avatars/a.jpg', 'https://signed/a.jpg']]))).toEqual({
      id: 'user-a',
      nickname: '스카이',
      avatarKey: 'fox',
      avatar: 'fox',
      avatarPath: 'avatars/a.jpg',
      avatarUri: 'https://signed/a.jpg',
      // 닉네임은 마지막 변경으로부터 7일 뒤에 다시 바꿀 수 있다.
      nicknameChangeAvailableAt: '2026-08-08T00:00:00.000Z',
    });
  });

  it('avatar_key가 없으면 ID 해시로 기본 아바타를 배정한다', () => {
    const mapped = mapProfile({ ...row, avatar_key: null }, NO_URLS);
    expect(mapped.avatarKey).toBeUndefined();
    expect(mapped.avatar).toBe(defaultAvatar('user-a'));
  });

  it('서명 URL이 없으면 avatarUri를 비운다', () => {
    expect(mapProfile(row, NO_URLS).avatarUri).toBeUndefined();
    expect(mapProfile({ ...row, avatar_path: null }, NO_URLS).avatarPath).toBeUndefined();
  });

  it('닉네임을 바꾼 적이 없으면 제한이 없다', () => {
    expect(mapProfile({ ...row, nickname_changed_at: null }, NO_URLS).nicknameChangeAvailableAt)
      .toBeUndefined();
  });
});

describe('mapRoom', () => {
  const row: RoomRow = {
    id: 'room-1',
    name: '테스트 방',
    owner_id: 'user-a',
    base_amount: 50_000,
    capacity: 4,
    status: 'open',
    created_at: '2026-08-03T00:00:00.000Z',
    closed_at: null,
  };

  it('행을 방으로 옮긴다', () => {
    expect(mapRoom(row, 'TEST12')).toEqual({
      id: 'room-1',
      ownerId: 'user-a',
      name: '테스트 방',
      inviteCode: 'TEST12',
      baseAmount: 50_000,
      capacity: 4,
      status: 'OPEN',
      createdAt: '2026-08-03T00:00:00.000Z',
      closedAt: undefined,
    });
  });

  it('초대 코드를 주지 않으면 빈 문자열로 둔다', () => {
    expect(mapRoom(row).inviteCode).toBe('');
  });

  it('상태를 대문자 표기로 바꾼다', () => {
    expect(mapRoom({ ...row, status: 'closed', closed_at: '2026-08-10T00:00:00.000Z' }))
      .toMatchObject({ status: 'CLOSED', closedAt: '2026-08-10T00:00:00.000Z' });
  });
});

describe('mapRoomMember', () => {
  const row: RoomMemberRow = {
    room_id: 'room-1',
    user_id: 'user-a',
    role: 'owner',
    status: 'active',
    joined_at: '2026-08-03T00:00:00.000Z',
    nickname_change_required: false,
  };

  it('행을 방 멤버로 옮긴다', () => {
    expect(mapRoomMember(row)).toEqual({
      roomId: 'room-1',
      userId: 'user-a',
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: '2026-08-03T00:00:00.000Z',
      nicknameChangeRequired: false,
    });
  });

  it('owner가 아니면 MEMBER다', () => {
    expect(mapRoomMember({ ...row, role: 'member' }).role).toBe('MEMBER');
  });

  // 열이 추가되기 전에 캐시된 행이나 아직 값이 없는 행은 null로 온다. 차단은
  // 명시적으로 표시된 경우에만 성립해야 하므로 null은 "막히지 않음"이다.
  it('중복 표시가 없으면 막히지 않은 것으로 읽는다', () => {
    expect(
      mapRoomMember({ ...row, nickname_change_required: null }).nicknameChangeRequired,
    ).toBe(false);
  });

  it('중복 표시를 그대로 옮긴다', () => {
    expect(
      mapRoomMember({ ...row, nickname_change_required: true }).nicknameChangeRequired,
    ).toBe(true);
  });
});

describe('mapPeriod', () => {
  const row: PeriodStatusRow = {
    id: 'period-1',
    room_id: 'room-1',
    week_index: 1,
    week_start: '2026-08-03',
    week_end: '2026-08-07',
    selected_day_count: 5,
    valid_day_count: 4,
    holiday_version_id: 'v1',
    finalized_at: null,
    created_at: '2026-08-03T00:00:00.000Z',
    state: 'active',
  };

  it('행과 날짜 목록을 주차로 옮긴다', () => {
    const days = [
      { period_id: 'period-1', day_on: '2026-08-05', is_holiday: false },
      { period_id: 'period-1', day_on: '2026-08-03', is_holiday: true },
      { period_id: 'period-1', day_on: '2026-08-04', is_holiday: false },
    ];
    expect(mapPeriod(row, days)).toEqual({
      id: 'period-1',
      roomId: 'room-1',
      weekIndex: 1,
      weekStart: '2026-08-03',
      weekEnd: '2026-08-07',
      selectedDayCount: 5,
      validDayCount: 4,
      holidayDates: ['2026-08-03'],
      holidayVersionId: 'v1',
      phase: 'ACTIVE',
      isRestWeek: false,
      finalizedAt: undefined,
      createdAt: '2026-08-03T00:00:00.000Z',
    });
  });

  it('공휴일을 날짜순으로 정렬한다', () => {
    const days = [
      { period_id: 'period-1', day_on: '2026-08-06', is_holiday: true },
      { period_id: 'period-1', day_on: '2026-08-03', is_holiday: true },
      { period_id: 'period-1', day_on: '2026-08-04', is_holiday: false },
    ];
    // 입력 순서와 무관하게 오름차순이어야 한도 계산이 안정적이다.
    expect(mapPeriod(row, days).holidayDates).toEqual(['2026-08-03', '2026-08-06']);
  });

  it('입력 배열을 건드리지 않는다', () => {
    const days = [
      { period_id: 'period-1', day_on: '2026-08-06', is_holiday: true },
      { period_id: 'period-1', day_on: '2026-08-03', is_holiday: true },
    ];
    mapPeriod(row, days);
    expect(days.map((day) => day.day_on)).toEqual(['2026-08-06', '2026-08-03']);
  });

  it('유효 일수가 0이면 쉬는 주다', () => {
    expect(mapPeriod({ ...row, valid_day_count: 0 }, []).isRestWeek).toBe(true);
  });
});

describe('mapPhase', () => {
  it.each([
    ['waiting', 'WAITING'],
    ['active', 'ACTIVE'],
    ['adjustment', 'ADJUSTMENT'],
    ['archived', 'ARCHIVED'],
  ] as const)('%s는 %s가 된다', (state, expected) => {
    expect(mapPhase(state)).toBe(expected);
  });

  it('settling만 이름이 다르다', () => {
    // DB는 settling, 앱은 SETTLEMENT를 쓴다. 단순 대문자 변환이 아니다.
    expect(mapPhase('settling')).toBe('SETTLEMENT');
  });
});

describe('mapMemberStatus', () => {
  it.each([
    ['active', 'ACTIVE'],
    ['left', 'LEFT'],
    ['removed', 'REMOVED'],
    ['account_deleted', 'ACCOUNT_DELETED'],
  ] as const)('%s는 %s가 된다', (status, expected) => {
    expect(mapMemberStatus(status)).toBe(expected);
  });
});

describe('mapPeriodMember', () => {
  const row: PeriodMemberRow = {
    period_id: 'period-1',
    user_id: 'user-a',
    status: 'active',
    joined_at: '2026-08-03T00:00:00.000Z',
    joined_on: '2026-08-03',
    is_late_join: false,
    eligible_day_count: 5,
    applied_limit: '50000',
  };

  it('행을 주차 멤버로 옮긴다', () => {
    expect(mapPeriodMember(row)).toEqual({
      periodId: 'period-1',
      userId: 'user-a',
      joinedAt: '2026-08-03T00:00:00.000Z',
      joinedDate: '2026-08-03',
      eligibleDayCount: 5,
      appliedLimit: 50_000,
      status: 'ACTIVE',
      isLateJoiner: false,
    });
  });

  it('합류일 형식이 틀리면 거부한다', () => {
    expect(() => mapPeriodMember({ ...row, joined_on: '20260803' })).toThrow();
  });
});

describe('mapPeriodResult', () => {
  const row: PeriodResultRow = {
    period_id: 'period-1',
    room_id: 'room-1',
    user_id: 'user-a',
    nickname_snapshot: '스카이',
    applied_limit: 50_000,
    spent_amount: 60_000,
    remaining_amount: -10_000,
    achieved: false,
    is_crown: false,
    finalized_at: '2026-08-08T03:00:00.000Z',
  };

  it('행을 정산 결과로 옮긴다', () => {
    expect(mapPeriodResult(row)).toEqual({
      periodId: 'period-1',
      roomId: 'room-1',
      userId: 'user-a',
      // 정산 시점의 닉네임을 박제한다. 이후 닉네임을 바꿔도 결과는 그대로다.
      nickname: '스카이',
      appliedLimit: 50_000,
      spentAmount: 60_000,
      remainingAmount: -10_000,
      achieved: false,
      isCrown: false,
      finalizedAt: '2026-08-08T03:00:00.000Z',
    });
  });
});

describe('mapStats', () => {
  it('행을 누적 통계로 옮긴다', () => {
    expect(mapStats({
      room_id: 'room-1',
      user_id: 'user-a',
      participated_week_count: 3,
      achieved_week_count: 2,
      crown_count: 1,
      current_streak: 2,
    })).toEqual({
      roomId: 'room-1',
      userId: 'user-a',
      participatedWeekCount: 3,
      achievedWeekCount: 2,
      crownCount: 1,
      currentStreak: 2,
    });
  });
});

describe('mapNotification', () => {
  const row: NotificationRow = {
    id: 'noti-1',
    user_id: 'user-a',
    kind: 'COMMENT_ADDED',
    actor_id: 'user-b',
    room_id: 'room-1',
    period_id: 'period-1',
    expense_id: 'expense-1',
    comment_id: 'comment-1',
    post_id: null,
    route: '/expense/expense-1',
    read_at: null,
    created_at: '2026-08-05T05:00:00.000Z',
  };

  it('행을 소식으로 옮긴다', () => {
    expect(mapNotification(row)).toEqual({
      id: 'noti-1',
      userId: 'user-a',
      kind: 'COMMENT_ADDED',
      actorId: 'user-b',
      roomId: 'room-1',
      periodId: 'period-1',
      expenseId: 'expense-1',
      commentId: 'comment-1',
      postId: undefined,
      route: '/expense/expense-1',
      readAt: undefined,
      createdAt: '2026-08-05T05:00:00.000Z',
    });
  });

  it('null 참조를 모두 undefined로 바꾼다', () => {
    const mapped = mapNotification({
      ...row,
      actor_id: null,
      room_id: null,
      period_id: null,
      expense_id: null,
      comment_id: null,
    });
    expect(mapped).toMatchObject({
      actorId: undefined,
      roomId: undefined,
      periodId: undefined,
      expenseId: undefined,
      commentId: undefined,
    });
  });
});

describe('mapExpense', () => {
  const row: ExpenseRow = {
    id: 'expense-1',
    client_request_id: 'req-1',
    period_id: 'period-1',
    user_id: 'user-a',
    amount: 30_000,
    point_amount: 0,
    category: 'lunch',
    memo: null,
    photo_path: 'photos/a.jpg',
    occurred_at: '2026-08-05T03:00:00.000Z',
    created_at: '2026-08-05T03:00:00.000Z',
    updated_at: '2026-08-05T03:10:00.000Z',
    deleted_at: null,
    version: 1,
  };

  it('행을 지출로 옮긴다', () => {
    expect(mapExpense(row, new Map([['photos/a.jpg', 'https://signed/a.jpg']]))).toEqual({
      id: 'expense-1',
      clientRequestId: 'req-1',
      periodId: 'period-1',
      userId: 'user-a',
      amount: 30_000,
      pointAmount: 0,
      category: '점심',
      memo: '',
      photoPath: 'photos/a.jpg',
      photoUri: 'https://signed/a.jpg',
      occurredAt: '2026-08-05T03:00:00.000Z',
      createdAt: '2026-08-05T03:00:00.000Z',
      updatedAt: '2026-08-05T03:10:00.000Z',
      deletedAt: undefined,
      syncStatus: 'SYNCED',
      version: 1,
    });
  });

  it('목록용 사진 URL은 원본 경로의 결정적 썸네일 경로에서 읽는다', () => {
    const thumbnailPath = expenseThumbnailPath('photos/a.jpg');
    expect(thumbnailPath).toBe('photos/a.thumb.jpg');
    expect(mapExpense(row, NO_URLS, new Map([[thumbnailPath, 'https://signed/a-thumb.jpg']]))).toMatchObject({
      photoThumbnailUri: 'https://signed/a-thumb.jpg',
    });
  });

  it.each([
    ['lunch', '점심'],
    ['coffee', '커피'],
    ['snack', '간식'],
    ['dinner', '저녁'],
    ['essential', '필수품'],
    ['luxury', '사치품'],
  ] as const)('카테고리 %s를 %s로 되돌린다', (dbCategory, appCategory) => {
    expect(mapExpense({ ...row, category: dbCategory }, NO_URLS).category).toBe(appCategory);
  });

  it('memo가 null이면 빈 문자열로 채운다', () => {
    expect(mapExpense(row, NO_URLS).memo).toBe('');
    expect(mapExpense({ ...row, memo: '점심값' }, NO_URLS).memo).toBe('점심값');
  });

  it('사진 경로가 없으면 URI도 비운다', () => {
    const mapped = mapExpense({ ...row, photo_path: null }, NO_URLS);
    expect(mapped.photoPath).toBeUndefined();
    expect(mapped.photoUri).toBeUndefined();
  });

  it('서버에서 온 지출은 항상 SYNCED다', () => {
    expect(mapExpense(row, NO_URLS).syncStatus).toBe('SYNCED');
  });

  it('금액이 정수가 아니면 거부한다', () => {
    expect(() => mapExpense({ ...row, amount: 1.5 }, NO_URLS))
      .toThrow('지출 금액 응답이 올바르지 않아요.');
    expect(() => mapExpense({ ...row, point_amount: 'x' }, NO_URLS))
      .toThrow('포인트 사용 금액 응답이 올바르지 않아요.');
  });
});

describe('mapComment', () => {
  const row: CommentRow = {
    id: 'comment-1',
    client_request_id: 'req-c1',
    expense_id: 'expense-1',
    user_id: 'user-b',
    body: '맛있겠다',
    reply_to_comment_id: null,
    created_at: '2026-08-05T05:00:00.000Z',
    updated_at: '2026-08-05T05:00:00.000Z',
    deleted_at: null,
    version: 1,
  };

  it('행을 댓글로 옮긴다', () => {
    expect(mapComment(row)).toEqual({
      id: 'comment-1',
      clientRequestId: 'req-c1',
      expenseId: 'expense-1',
      userId: 'user-b',
      body: '맛있겠다',
      replyToId: undefined,
      createdAt: '2026-08-05T05:00:00.000Z',
      updatedAt: '2026-08-05T05:00:00.000Z',
      deletedAt: undefined,
      syncStatus: 'SYNCED',
      version: 1,
    });
  });

  it('삭제된 댓글은 원문을 감춘다', () => {
    // 서버가 본문을 지우지 않고 내려보내도 화면에 노출되면 안 된다.
    const mapped = mapComment({ ...row, deleted_at: '2026-08-05T06:00:00.000Z' });
    expect(mapped.body).toBe('삭제된 메시지입니다.');
    expect(mapped.deletedAt).toBe('2026-08-05T06:00:00.000Z');
  });

  it('답글 대상을 옮긴다', () => {
    expect(mapComment({ ...row, reply_to_comment_id: 'comment-0' }).replyToId).toBe('comment-0');
  });
});

describe('mapRoomPost', () => {
  const row: RoomPostRow = {
    id: 'post-1',
    client_request_id: 'req-p1',
    room_id: 'room-1',
    period_id: null,
    kind: 'notice',
    category: 'chat',
    author_id: 'user-a',
    title: '공지 제목',
    body: '공지입니다',
    poll_closes_at: null,
    photo_path: null,
    secret_purchase_amount: null,
    secret_purchase_occurred_at: null,
    secret_purchase_category: null,
    created_at: '2026-08-04T01:00:00.000Z',
    updated_at: '2026-08-04T01:00:00.000Z',
    deleted_at: null,
    version: 1,
  };

  it('행을 게시글로 옮긴다', () => {
    expect(mapRoomPost(row)).toEqual({
      id: 'post-1',
      clientRequestId: 'req-p1',
      roomId: 'room-1',
      periodId: undefined,
      kind: 'NOTICE',
      category: '잡담',
      authorId: 'user-a',
      title: '공지 제목',
      body: '공지입니다',
      createdAt: '2026-08-04T01:00:00.000Z',
      updatedAt: '2026-08-04T01:00:00.000Z',
      deletedAt: undefined,
      version: 1,
    });
  });

  it('notice가 아니면 POST다', () => {
    expect(mapRoomPost({ ...row, kind: 'post' }).kind).toBe('POST');
  });

  it('카테고리 없는 poll을 POLL과 마감 시각으로 옮긴다', () => {
    expect(mapRoomPost({ ...row, kind: 'poll', category: null, poll_closes_at: '2026-08-06T15:00:00.000Z' }))
      .toMatchObject({ kind: 'POLL', category: undefined, pollClosesAt: '2026-08-06T15:00:00.000Z' });
  });

  it('삭제된 게시글은 원문을 감춘다', () => {
    expect(mapRoomPost({ ...row, deleted_at: '2026-08-05T00:00:00.000Z' }).body)
      .toBe('삭제된 기록입니다.');
  });
});

describe('mapRoomPostComment', () => {
  const row: RoomPostCommentRow = {
    id: 'post-comment-1',
    client_request_id: 'req-pc1',
    post_id: 'post-1',
    author_id: 'user-b',
    body: '확인했어요',
    reply_to_comment_id: null,
    created_at: '2026-08-04T02:00:00.000Z',
    updated_at: '2026-08-04T02:00:00.000Z',
    deleted_at: null,
    version: 1,
  };

  it('행을 게시글 댓글로 옮긴다', () => {
    expect(mapRoomPostComment(row)).toEqual({
      id: 'post-comment-1',
      clientRequestId: 'req-pc1',
      postId: 'post-1',
      authorId: 'user-b',
      body: '확인했어요',
      replyToId: undefined,
      createdAt: '2026-08-04T02:00:00.000Z',
      updatedAt: '2026-08-04T02:00:00.000Z',
      deletedAt: undefined,
      version: 1,
    });
  });

  it('삭제된 댓글은 원문을 감춘다', () => {
    expect(mapRoomPostComment({ ...row, deleted_at: '2026-08-05T00:00:00.000Z' }).body)
      .toBe('삭제된 댓글입니다.');
  });

  it('답글 대상을 옮긴다', () => {
    expect(mapRoomPostComment({ ...row, reply_to_comment_id: 'post-comment-0' }).replyToId)
      .toBe('post-comment-0');
  });
});

describe('반응 매퍼', () => {
  it('댓글 반응을 옮긴다', () => {
    expect(mapCommentReaction({
      comment_id: 'comment-1',
      user_id: 'user-a',
      emoji: '🩷',
      created_at: '2026-08-05T06:00:00.000Z',
    })).toEqual({
      commentId: 'comment-1',
      userId: 'user-a',
      emoji: '🩷',
      createdAt: '2026-08-05T06:00:00.000Z',
    });
  });

  it('게시글 반응을 옮긴다', () => {
    expect(mapRoomPostReaction({
      post_id: 'post-1',
      user_id: 'user-b',
      emoji: '👍',
      created_at: '2026-08-04T03:00:00.000Z',
    })).toEqual({
      postId: 'post-1',
      userId: 'user-b',
      emoji: '👍',
      createdAt: '2026-08-04T03:00:00.000Z',
    });
  });
});

describe('투표 매퍼', () => {
  it('선택지와 투표를 옮긴다', () => {
    expect(mapRoomPostPollOption({ id: 'option-1', post_id: 'post-1', body: '도시락', position: 0 }))
      .toEqual({ id: 'option-1', postId: 'post-1', body: '도시락', position: 0 });
    expect(mapRoomPostPollVote({
      post_id: 'post-1', option_id: 'option-1', user_id: 'user-a', created_at: '2026-08-05T06:00:00.000Z',
    })).toEqual({
      postId: 'post-1', optionId: 'option-1', userId: 'user-a', createdAt: '2026-08-05T06:00:00.000Z',
    });
  });
});

describe('예외 매퍼', () => {
  it('예외 신청을 옮긴다', () => {
    expect(mapExpenseException({
      expense_id: 'expense-1',
      reason: '기념일',
      requested_by: 'user-a',
      requested_at: '2026-08-05T03:30:00.000Z',
    })).toEqual({
      expenseId: 'expense-1',
      reason: '기념일',
      requestedBy: 'user-a',
      requestedAt: '2026-08-05T03:30:00.000Z',
    });
  });

  it('예외 응답을 옮긴다', () => {
    expect(mapExpenseExceptionResponse({
      expense_id: 'expense-1',
      user_id: 'user-b',
      decision: 'held',
      created_at: '2026-08-05T04:00:00.000Z',
    })).toEqual({
      expenseId: 'expense-1',
      userId: 'user-b',
      decision: 'HELD',
      createdAt: '2026-08-05T04:00:00.000Z',
    });
  });
});

describe('mapInvitePreview', () => {
  const payload = {
    room: { id: 'room-1', name: '테스트 방', base_amount: 50_000, capacity: 4, member_count: 2 },
    current_period: {
      id: 'period-1',
      week_start: '2026-08-03',
      week_end: '2026-08-07',
      selected_day_count: 5,
      valid_day_count: 4,
      holidays: [{ date: '2026-08-03' }],
    },
    join: {
      joined_on: '2026-08-04',
      eligible_day_count: 3,
      applied_limit: 30_000,
      is_late_join: true,
      participates_this_week: true,
      can_join: true,
    },
  };

  it('RPC 페이로드를 초대 미리보기로 옮긴다', () => {
    expect(mapInvitePreview('TEST12', payload)).toEqual({
      code: 'TEST12',
      roomId: 'room-1',
      name: '테스트 방',
      baseAmount: 50_000,
      capacity: 4,
      memberCount: 2,
      currentPeriod: {
        id: 'period-1',
        weekStart: '2026-08-03',
        weekEnd: '2026-08-07',
        selectedDayCount: 5,
        validDayCount: 4,
        holidayDates: ['2026-08-03'],
      },
      joinedDate: '2026-08-04',
      eligibleDayCount: 3,
      appliedLimit: 30_000,
      isLateJoiner: true,
      participatesThisWeek: true,
      canJoin: true,
    });
  });

  it('진행 중인 주차가 없으면 비운다', () => {
    expect(mapInvitePreview('TEST12', { ...payload, current_period: null }).currentPeriod)
      .toBeUndefined();
  });

  it('room이나 join이 없으면 거부한다', () => {
    expect(() => mapInvitePreview('TEST12', { ...payload, room: null }))
      .toThrow('초대 정보 형식이 올바르지 않아요.');
    expect(() => mapInvitePreview('TEST12', { ...payload, join: null }))
      .toThrow('초대 정보 형식이 올바르지 않아요.');
  });

  it('불리언 필드는 true일 때만 true다', () => {
    // RPC가 null이나 문자열을 주더라도 조용히 참이 되면 안 된다.
    const mapped = mapInvitePreview('TEST12', {
      ...payload,
      join: { ...payload.join, is_late_join: 'true', can_join: null, participates_this_week: 1 },
    });
    expect(mapped).toMatchObject({
      isLateJoiner: false,
      canJoin: false,
      participatesThisWeek: false,
    });
  });
});
