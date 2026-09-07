import type { AppSnapshot } from '@/shared/api/types';
import { buildAppIndexes, type AppIndexes } from '@/shared/model/app-indexes';
import { deriveAppState, type AppDerivedState } from '@/shared/model/app-selectors';

/**
 * 이 세션에서 방금 상세를 열어 읽은 항목. 서버 읽음 행이 스냅샷에 실려 올 때까지
 * NEW가 남아 깜빡이는 것을 막는다. 로그인 사용자가 바뀌면 비운다.
 */
export type LocalReads = {
  expenseIds: ReadonlySet<string>;
  postIds: ReadonlySet<string>;
};

export type LocalReadKind = 'expense' | 'post';

const EMPTY_LOCAL_READS: LocalReads = {
  expenseIds: new Set<string>(),
  postIds: new Set<string>(),
};

export type AppStoreState = AppDerivedState & {
  snapshot: AppSnapshot | null;
  indexes: AppIndexes;
  localReads: LocalReads;
};

export type AppStore = {
  getState: () => AppStoreState;
  setSnapshot: (snapshot: AppSnapshot) => void;
  markReadLocally: (kind: LocalReadKind, id: string) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createAppStore(): AppStore {
  const emptyIndexes = buildAppIndexes(null);
  let state: AppStoreState = {
    snapshot: null,
    indexes: emptyIndexes,
    localReads: EMPTY_LOCAL_READS,
    ...deriveAppState(null, emptyIndexes),
  };
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setSnapshot: (incoming) => {
      const previousSnapshot = state.snapshot;
      const snapshot = shareAppSnapshot(previousSnapshot, incoming);
      if (snapshot === previousSnapshot) return;
      const indexes = buildAppIndexes(snapshot, previousSnapshot, state.indexes);
      const derivedState = deriveAppState(snapshot, indexes, previousSnapshot, state);
      state = {
        snapshot,
        indexes,
        localReads: previousSnapshot && previousSnapshot.currentUserId !== snapshot.currentUserId
          ? EMPTY_LOCAL_READS
          : state.localReads,
        ...derivedState,
      };
      listeners.forEach((listener) => listener());
    },
    markReadLocally: (kind, id) => {
      const key = kind === 'expense' ? 'expenseIds' : 'postIds';
      if (state.localReads[key].has(id)) return;
      const next = new Set(state.localReads[key]);
      next.add(id);
      state = { ...state, localReads: { ...state.localReads, [key]: next } };
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function structurallyShare<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const next = incoming.map((value, index) => structurallyShare(previous[index], value));
    return (
      previous.length === next.length && next.every((value, index) => value === previous[index])
        ? previous
        : next
    ) as T;
  }
  if (isRecord(previous) && isRecord(incoming)) {
    const next = shareRecord(previous, incoming);
    const keys = new Set([...Object.keys(previous), ...Object.keys(incoming)]);
    return [...keys].every((key) => Object.is(next[key], previous[key])) ? previous : next as T;
  }
  return incoming;
}

function shareAppSnapshot(previous: AppSnapshot | null, incoming: AppSnapshot): AppSnapshot {
  if (!previous || previous.currentUserId !== incoming.currentUserId) return incoming;
  const next: AppSnapshot = {
    currentUserId: incoming.currentUserId,
    profiles: shareRecords(previous.profiles, incoming.profiles, (value) => value.id),
    rooms: shareRecords(previous.rooms, incoming.rooms, (value) => value.id),
    roomMembers: shareRecords(
      previous.roomMembers,
      incoming.roomMembers,
      (value) => `${value.roomId}\u0000${value.userId}`,
    ),
    periods: shareRecords(previous.periods, incoming.periods, (value) => value.id),
    periodMembers: shareRecords(
      previous.periodMembers,
      incoming.periodMembers,
      (value) => `${value.periodId}\u0000${value.userId}`,
    ),
    periodResults: shareRecords(
      previous.periodResults,
      incoming.periodResults,
      (value) => `${value.periodId}\u0000${value.userId}`,
    ),
    memberStats: shareRecords(
      previous.memberStats,
      incoming.memberStats,
      (value) => `${value.roomId}\u0000${value.userId}`,
    ),
    expenses: shareRecords(previous.expenses, incoming.expenses, (value) => value.id),
    expenseReads: previous.expenseReads || incoming.expenseReads
      ? shareRecords(
        previous.expenseReads ?? [],
        incoming.expenseReads ?? [],
        (value) => `${value.expenseId}\u0000${value.userId}`,
      )
      : undefined,
    comments: shareRecords(previous.comments, incoming.comments, (value) => value.id),
    commentMentions: shareRecords(
      previous.commentMentions,
      incoming.commentMentions,
      (value) => `${value.commentId}\u0000${value.start}`,
    ),
    commentReactions: shareRecords(
      previous.commentReactions,
      incoming.commentReactions,
      (value) => `${value.commentId}\u0000${value.userId}\u0000${value.emoji}`,
    ),
    roomPosts: shareRecords(previous.roomPosts, incoming.roomPosts, (value) => value.id),
    roomPostComments: shareRecords(previous.roomPostComments, incoming.roomPostComments, (value) => value.id),
    roomPostReactions: shareRecords(
      previous.roomPostReactions,
      incoming.roomPostReactions,
      (value) => `${value.postId}\u0000${value.userId}\u0000${value.emoji}`,
    ),
    roomPostReads: previous.roomPostReads || incoming.roomPostReads
      ? shareRecords(
        previous.roomPostReads ?? [],
        incoming.roomPostReads ?? [],
        (value) => `${value.postId}\u0000${value.userId}`,
      )
      : undefined,
    roomPostPollOptions: shareRecords(
      previous.roomPostPollOptions,
      incoming.roomPostPollOptions,
      (value) => value.id,
    ),
    roomPostPollVotes: shareRecords(
      previous.roomPostPollVotes,
      incoming.roomPostPollVotes,
      (value) => `${value.postId}\u0000${value.userId}`,
    ),
    notifications: shareRecords(previous.notifications, incoming.notifications, (value) => value.id),
    winnerNudgeGrants: previous.winnerNudgeGrants || incoming.winnerNudgeGrants
      ? shareRecords(
        previous.winnerNudgeGrants ?? [],
        incoming.winnerNudgeGrants ?? [],
        (value) => value.id,
      )
      : undefined,
    expenseExceptions: shareRecords(
      previous.expenseExceptions,
      incoming.expenseExceptions,
      (value) => value.expenseId,
    ),
    expenseExceptionResponses: shareRecords(
      previous.expenseExceptionResponses,
      incoming.expenseExceptionResponses,
      (value) => `${value.expenseId}\u0000${value.userId}`,
    ),
    processedRequestIds: structurallyShare(previous.processedRequestIds, incoming.processedRequestIds),
  };
  return Object.keys(next).every(
    (key) => next[key as keyof AppSnapshot] === previous[key as keyof AppSnapshot],
  )
    ? previous
    : next;
}

function shareRecords<T>(previous: T[], incoming: T[], keyOf: (value: T) => string): T[] {
  const previousByKey = new Map(previous.map((value) => [keyOf(value), value]));
  const next = incoming.map((value) => {
    const oldValue = previousByKey.get(keyOf(value));
    return oldValue === undefined ? value : structurallyShare(oldValue, value);
  });
  return previous.length === next.length && next.every((value, index) => value === previous[index])
    ? previous
    : next;
}

function shareRecord(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(incoming).map(([key, value]) => [key, structurallyShare(previous[key], value)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
