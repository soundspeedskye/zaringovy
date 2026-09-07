import { describe, expect, it } from 'vitest';

import type { AppSnapshot } from '@/shared/api/types';
import { buildAppIndexes, type AppIndexes } from '@/shared/model/app-indexes';

/**
 * buildAppIndexes는 스냅샷 슬라이스의 참조 동일성으로 인덱스를 메모이제이션한다.
 * 이 캐시가 깨져도 값은 그대로라 동작 테스트로는 잡히지 않고, 리렌더가 늘어나며
 * 조용히 느려질 뿐이다. 여기서는 값이 아니라 참조를 검사해 재사용 규칙을 고정한다.
 */

/** 인덱스 필드가 의존하는 스냅샷 슬라이스. 이 중 하나라도 참조가 바뀌면 재계산된다. */
const INDEX_DEPENDENCIES = {
  roomById: ['rooms'],
  periodById: ['periods'],
  profileById: ['profiles'],
  membersByPeriodId: ['periodMembers'],
  expenseById: ['expenses'],
  expensesByPeriodId: ['expenses'],
  expensesByPeriodAndUserId: ['expenses'],
  commentsByExpenseId: ['comments'],
  commentCountByExpenseId: ['comments'],
  mentionsByCommentId: ['commentMentions'],
  reactionsByCommentId: ['commentReactions'],
  postById: ['roomPosts'],
  postsByRoomId: ['roomPosts'],
  commentsByPostId: ['roomPostComments'],
  commentCountByPostId: ['roomPostComments'],
  reactionsByPostId: ['roomPostReactions'],
  pollOptionsByPostId: ['roomPostPollOptions', 'roomPostPollVotes'],
  pollVotesByPostId: ['roomPostPollOptions', 'roomPostPollVotes'],
  readExpenseIds: ['expenseReads', 'roomPostReads'],
  readPostIds: ['expenseReads', 'roomPostReads'],
  resultsByPeriodId: ['periodResults'],
  statsByRoomId: ['memberStats'],
  exceptionByExpenseId: EXCEPTION_INPUTS(),
  approvedUserIdsByExpenseId: EXCEPTION_INPUTS(),
  heldUserIdsByExpenseId: EXCEPTION_INPUTS(),
  settlementExcludedExpenseIds: EXCEPTION_INPUTS(),
  crownIdsByPeriodId: [
    'periods',
    'periodResults',
    'periodMembers',
    'profiles',
    'expenses',
    'expenseExceptions',
    'expenseExceptionResponses',
  ],
} satisfies Record<keyof AppIndexes, readonly (keyof AppSnapshot)[]>;

function EXCEPTION_INPUTS(): readonly (keyof AppSnapshot)[] {
  return ['expenseExceptions', 'expenseExceptionResponses', 'periodMembers', 'expenses'];
}

/** 참조를 갈아끼워 볼 배열 슬라이스 전부. */
const SLICES = [
  'profiles',
  'rooms',
  'roomMembers',
  'periods',
  'periodMembers',
  'periodResults',
  'memberStats',
  'expenses',
  'comments',
  'commentMentions',
  'commentReactions',
  'roomPosts',
  'roomPostComments',
  'roomPostReactions',
  'roomPostPollOptions',
  'roomPostPollVotes',
  'roomPostReads',
  'expenseReads',
  'notifications',
  'expenseExceptions',
  'expenseExceptionResponses',
  'processedRequestIds',
] as const satisfies readonly (keyof AppSnapshot)[];

type Slice = (typeof SLICES)[number];

/** 내용은 그대로 두고 배열 참조만 교체한다. */
function touch(snapshot: AppSnapshot, slice: Slice): AppSnapshot {
  return { ...snapshot, [slice]: [...(snapshot[slice] ?? [])] };
}

/** 어떤 슬라이스를 건드렸을 때 해당 인덱스가 참조 재사용되는지. */
function reusedSlicesFor(field: keyof AppIndexes): Slice[] {
  const base = createDenseSnapshot();
  const first = buildAppIndexes(base);
  return SLICES.filter((slice) => {
    const second = buildAppIndexes(touch(base, slice), base, first);
    return second[field] === first[field];
  });
}

describe('buildAppIndexes 참조 재사용', () => {
  const fields = Object.keys(INDEX_DEPENDENCIES) as (keyof AppIndexes)[];

  it('AppIndexes의 모든 필드를 검사 대상으로 삼는다', () => {
    const covered = new Set(fields);
    const actual = Object.keys(buildAppIndexes(createDenseSnapshot()));
    expect(actual.filter((key) => !covered.has(key as keyof AppIndexes))).toEqual([]);
  });

  it.each(fields)('%s는 의존 슬라이스가 바뀔 때만 재계산된다', (field) => {
    const deps = new Set<string>(INDEX_DEPENDENCIES[field]);
    const expected = SLICES.filter((slice) => !deps.has(slice));
    expect(reusedSlicesFor(field)).toEqual(expected);
  });

  it('이전 스냅샷을 주지 않으면 항상 새로 만든다', () => {
    const snapshot = createDenseSnapshot();
    const first = buildAppIndexes(snapshot);
    const second = buildAppIndexes(snapshot);
    for (const field of fields) {
      expect(second[field]).not.toBe(first[field]);
    }
  });

  it('스냅샷이 통째로 같으면 모든 인덱스를 재사용한다', () => {
    const snapshot = createDenseSnapshot();
    const first = buildAppIndexes(snapshot);
    const second = buildAppIndexes(snapshot, snapshot, first);
    for (const field of fields) {
      expect(second[field]).toBe(first[field]);
    }
  });
});

describe('마감된 주차의 왕관 재사용', () => {
  it('periodResults가 그대로면 지출이 바뀌어도 마감 주차의 배열을 재사용한다', () => {
    const base = createDenseSnapshot();
    const first = buildAppIndexes(base);
    // 지출 참조를 바꾸면 crownInputsAreShared가 깨져 Map은 다시 만들어진다.
    const second = buildAppIndexes(touch(base, 'expenses'), base, first);

    expect(second.crownIdsByPeriodId).not.toBe(first.crownIdsByPeriodId);
    // 마감 주차는 periodResults에서만 파생되므로 내부 배열은 그대로 재사용된다.
    expect(second.crownIdsByPeriodId.get('period-done'))
      .toBe(first.crownIdsByPeriodId.get('period-done'));
    // 진행 중 주차는 지출에서 파생되므로 다시 계산된다.
    expect(second.crownIdsByPeriodId.get('period-live'))
      .not.toBe(first.crownIdsByPeriodId.get('period-live'));
  });

  it('periodResults가 바뀌면 마감 주차도 다시 계산한다', () => {
    const base = createDenseSnapshot();
    const first = buildAppIndexes(base);
    const second = buildAppIndexes(touch(base, 'periodResults'), base, first);

    expect(second.crownIdsByPeriodId.get('period-done'))
      .not.toBe(first.crownIdsByPeriodId.get('period-done'));
  });

  it('마감 주차의 왕관은 periodResults의 isCrown을 그대로 따른다', () => {
    const indexes = buildAppIndexes(createDenseSnapshot());
    expect(indexes.crownIdsByPeriodId.get('period-done')).toEqual(['user-b']);
  });
});

describe('빈 스냅샷', () => {
  it('null이면 비어 있는 인덱스를 만든다', () => {
    const indexes = buildAppIndexes(null);
    expect(indexes.roomById.size).toBe(0);
    expect(indexes.settlementExcludedExpenseIds.size).toBe(0);
  });
});

/** 모든 슬라이스가 채워진 스냅샷. 마감 주차와 진행 중 주차를 하나씩 둔다. */
function createDenseSnapshot(): AppSnapshot {
  return {
    currentUserId: 'user-a',
    profiles: [
      { id: 'user-a', nickname: 'A', avatar: 'fox' },
      { id: 'user-b', nickname: 'B', avatar: 'rabbit' },
    ],
    rooms: [{
      id: 'room-1',
      ownerId: 'user-a',
      name: '테스트 방',
      inviteCode: 'TEST12',
      baseAmount: 50_000,
      capacity: 4,
      status: 'OPEN',
      createdAt: '2026-08-03T00:00:00.000Z',
    }],
    roomMembers: [
      { roomId: 'room-1', userId: 'user-a', role: 'OWNER', status: 'ACTIVE', joinedAt: '2026-08-03T00:00:00.000Z', nicknameChangeRequired: false },
      { roomId: 'room-1', userId: 'user-b', role: 'MEMBER', status: 'ACTIVE', joinedAt: '2026-08-03T00:00:00.000Z', nicknameChangeRequired: false },
    ],
    periods: [
      {
        id: 'period-done',
        roomId: 'room-1',
        weekIndex: 1,
        weekStart: '2026-07-27',
        weekEnd: '2026-07-31',
        selectedDayCount: 5,
        validDayCount: 5,
        holidayDates: [],
        holidayVersionId: 'v',
        phase: 'ARCHIVED',
        isRestWeek: false,
        createdAt: '2026-07-27T00:00:00.000Z',
      },
      {
        id: 'period-live',
        roomId: 'room-1',
        weekIndex: 2,
        weekStart: '2026-08-03',
        weekEnd: '2026-08-07',
        selectedDayCount: 5,
        validDayCount: 5,
        holidayDates: [],
        holidayVersionId: 'v',
        phase: 'ACTIVE',
        isRestWeek: false,
        createdAt: '2026-08-03T00:00:00.000Z',
      },
    ],
    periodMembers: [
      { periodId: 'period-done', userId: 'user-a', joinedAt: '2026-07-27T00:00:00.000Z', joinedDate: '2026-07-27', eligibleDayCount: 5, appliedLimit: 50_000, status: 'ACTIVE', isLateJoiner: false },
      { periodId: 'period-done', userId: 'user-b', joinedAt: '2026-07-27T00:00:00.000Z', joinedDate: '2026-07-27', eligibleDayCount: 5, appliedLimit: 50_000, status: 'ACTIVE', isLateJoiner: false },
      { periodId: 'period-live', userId: 'user-a', joinedAt: '2026-08-03T00:00:00.000Z', joinedDate: '2026-08-03', eligibleDayCount: 5, appliedLimit: 50_000, status: 'ACTIVE', isLateJoiner: false },
      { periodId: 'period-live', userId: 'user-b', joinedAt: '2026-08-03T00:00:00.000Z', joinedDate: '2026-08-03', eligibleDayCount: 5, appliedLimit: 50_000, status: 'ACTIVE', isLateJoiner: false },
    ],
    periodResults: [
      { periodId: 'period-done', roomId: 'room-1', userId: 'user-a', nickname: 'A', appliedLimit: 50_000, spentAmount: 40_000, remainingAmount: 10_000, achieved: true, isCrown: false, finalizedAt: '2026-08-01T03:00:00.000Z' },
      { periodId: 'period-done', roomId: 'room-1', userId: 'user-b', nickname: 'B', appliedLimit: 50_000, spentAmount: 10_000, remainingAmount: 40_000, achieved: true, isCrown: true, finalizedAt: '2026-08-01T03:00:00.000Z' },
    ],
    memberStats: [
      { roomId: 'room-1', userId: 'user-a', participatedWeekCount: 1, achievedWeekCount: 1, crownCount: 0, currentStreak: 1 },
      { roomId: 'room-1', userId: 'user-b', participatedWeekCount: 1, achievedWeekCount: 1, crownCount: 1, currentStreak: 1 },
    ],
    expenses: [
      { id: 'expense-done', clientRequestId: 'req-done', periodId: 'period-done', userId: 'user-a', amount: 40_000, pointAmount: 0, category: '저녁', memo: '', occurredAt: '2026-07-29T03:00:00.000Z', createdAt: '2026-07-29T03:00:00.000Z', updatedAt: '2026-07-29T03:00:00.000Z', syncStatus: 'SYNCED' },
      { id: 'expense-live', clientRequestId: 'req-live', periodId: 'period-live', userId: 'user-a', amount: 30_000, pointAmount: 0, category: '점심', memo: '', occurredAt: '2026-08-05T03:00:00.000Z', createdAt: '2026-08-05T03:00:00.000Z', updatedAt: '2026-08-05T03:00:00.000Z', syncStatus: 'SYNCED' },
      { id: 'expense-b', clientRequestId: 'req-b', periodId: 'period-live', userId: 'user-b', amount: 5_000, pointAmount: 0, category: '커피', memo: '', occurredAt: '2026-08-05T04:00:00.000Z', createdAt: '2026-08-05T04:00:00.000Z', updatedAt: '2026-08-05T04:00:00.000Z', syncStatus: 'SYNCED' },
    ],
    comments: [
      { id: 'comment-1', clientRequestId: 'req-c1', expenseId: 'expense-live', userId: 'user-b', body: '맛있겠다', createdAt: '2026-08-05T05:00:00.000Z', updatedAt: '2026-08-05T05:00:00.000Z', syncStatus: 'SYNCED' },
    ],
    commentMentions: [],
    commentReactions: [
      { commentId: 'comment-1', userId: 'user-a', emoji: '🩷', createdAt: '2026-08-05T06:00:00.000Z' },
    ],
    roomPosts: [
      { id: 'post-1', clientRequestId: 'req-p1', roomId: 'room-1', kind: 'NOTICE', authorId: 'user-a', body: '공지', createdAt: '2026-08-04T01:00:00.000Z', updatedAt: '2026-08-04T01:00:00.000Z', version: 1 },
    ],
    roomPostComments: [
      { id: 'post-comment-1', clientRequestId: 'req-pc1', postId: 'post-1', authorId: 'user-b', body: '확인했어요', createdAt: '2026-08-04T02:00:00.000Z', updatedAt: '2026-08-04T02:00:00.000Z', version: 1 },
    ],
    roomPostReactions: [
      { postId: 'post-1', userId: 'user-b', emoji: '👍', createdAt: '2026-08-04T03:00:00.000Z' },
    ],
    roomPostReads: [
      { postId: 'post-1', userId: 'user-a', readAt: '2026-08-04T04:00:00.000Z' },
    ],
    expenseReads: [
      { expenseId: 'expense-b', userId: 'user-a', readAt: '2026-08-05T05:00:00.000Z' },
    ],
    roomPostPollOptions: [],
    roomPostPollVotes: [],
    notifications: [
      { id: 'noti-1', userId: 'user-a', kind: 'COMMENT_ADDED', route: '/expense/expense-live', createdAt: '2026-08-05T05:00:00.000Z' },
    ],
    expenseExceptions: [
      { expenseId: 'expense-live', reason: '기념일', requestedBy: 'user-a', requestedAt: '2026-08-05T03:30:00.000Z' },
    ],
    expenseExceptionResponses: [
      { expenseId: 'expense-live', userId: 'user-b', decision: 'APPROVED', createdAt: '2026-08-05T04:00:00.000Z' },
    ],
    processedRequestIds: ['req-done'],
  };
}
