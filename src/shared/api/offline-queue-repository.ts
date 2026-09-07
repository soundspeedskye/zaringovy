import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import {
  isSessionBoundRepository,
  supportsExpensePhotoCleanup,
  type AppRepository,
  type Unsubscribe,
} from '@/shared/api/repository';
import type {
  AddCommentInput,
  AddRoomPostCommentInput,
  AddRoomPostInput,
  AddExpenseInput,
  AppSnapshot,
  Comment,
  CommentReactionEmoji,
  CreateRoomInput,
  Expense,
  InvitePreview,
  Room,
  RoomMember,
  Profile,
  RoomPost,
  RoomPostComment,
  RoomPostReactionEmoji,
  ExpenseExceptionResponseDecision,
  SwitchRoomInput,
  UpdateRoomSettingsInput,
  UpdateRoomPostInput,
} from '@/shared/api/types';
import {
  OFFLINE_QUEUE_STORAGE_KEY,
  OFFLINE_SNAPSHOT_STORAGE_KEY,
} from '@/shared/config/storage';
import { createPeriodTimeline } from '@/shared/lib/domain/period';

type QueueStatus = 'PENDING' | 'FAILED';
type MutationKind =
  | 'ADD_EXPENSE'
  | 'UPDATE_EXPENSE'
  | 'DELETE_EXPENSE'
  | 'ADD_COMMENT'
  | 'UPDATE_COMMENT'
  | 'DELETE_COMMENT';

export type OfflineMutationFailure = {
  code: string;
  message: string;
  copyableMessage: string;
  occurredAt: string;
  permanent: boolean;
};

export type OfflineMutationSummary = {
  operationId: string;
  requestId: string;
  kind: MutationKind;
  entityId: string;
  status: QueueStatus;
  attempts: number;
  enqueuedAt: string;
  nextAttemptAt?: string;
  failure?: OfflineMutationFailure;
};

export interface OfflineQueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface OfflineNetworkMonitor {
  fetch(): Promise<boolean>;
  subscribe(listener: (online: boolean) => void): Unsubscribe;
}

export type PersistedPhoto = {
  uri: string;
  owned: boolean;
};

export interface DurablePhotoStore {
  persist(sourceUri: string, operationId: string): Promise<PersistedPhoto>;
  remove(uri: string): Promise<void>;
}

export type OfflineQueueRepositoryOptions = {
  storage?: OfflineQueueStorage;
  storageKey?: string;
  snapshotStorageKey?: string;
  network?: OfflineNetworkMonitor;
  photoStore?: DurablePhotoStore;
  now?: () => number;
  randomId?: () => string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAutomaticAttempts?: number;
};

type OperationBase = {
  id: string;
  requestId: string;
  kind: MutationKind;
  userId: string;
  status: QueueStatus;
  sequence: number;
  attempts: number;
  enqueuedAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  failure?: OfflineMutationFailure;
  deadlineAt?: string;
  serverApplied?: boolean;
  cleanupPhotoPath?: string;
  photoRevision?: number;
  originalPhotoUri?: string;
  cachedPhotoUri?: string;
  ownsCachedPhoto?: boolean;
};

type AddExpenseOperation = OperationBase & {
  kind: 'ADD_EXPENSE';
  optimisticId: string;
  input: AddExpenseInput;
};

type UpdateExpenseOperation = OperationBase & {
  kind: 'UPDATE_EXPENSE';
  targetId: string;
  patch: Partial<AddExpenseInput>;
  baseEntity: Expense;
  baseVersion?: number;
};

type DeleteExpenseOperation = OperationBase & {
  kind: 'DELETE_EXPENSE';
  targetId: string;
  baseEntity: Expense;
  baseVersion?: number;
};

type AddCommentOperation = OperationBase & {
  kind: 'ADD_COMMENT';
  optimisticId: string;
  input: AddCommentInput;
};

type UpdateCommentOperation = OperationBase & {
  kind: 'UPDATE_COMMENT';
  targetId: string;
  body: string;
  baseEntity: Comment;
  baseVersion?: number;
};

type DeleteCommentOperation = OperationBase & {
  kind: 'DELETE_COMMENT';
  targetId: string;
  baseEntity: Comment;
  baseVersion?: number;
};

type MutationOperation =
  | AddExpenseOperation
  | UpdateExpenseOperation
  | DeleteExpenseOperation
  | AddCommentOperation
  | UpdateCommentOperation
  | DeleteCommentOperation;

type QueueEnvelope = {
  schemaVersion: 1;
  nextSequence: number;
  operations: MutationOperation[];
};

type SnapshotEnvelope = {
  schemaVersion: 1;
  snapshots: Record<string, AppSnapshot>;
};

const EMPTY_QUEUE: QueueEnvelope = {
  schemaVersion: 1,
  nextSequence: 1,
  operations: [],
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Offline-first decorator for the Supabase-backed repository.
 *
 * Mutations are durably written before network I/O and replayed in FIFO order.
 * Room creation, joining and invite preview intentionally remain direct server
 * operations because their result depends on current room state.
 */
export class OfflineQueueRepository implements AppRepository {
  private readonly storage: OfflineQueueStorage;
  private readonly storageKey: string;
  private readonly snapshotStorageKey: string;
  private readonly network: OfflineNetworkMonitor;
  private readonly photoStore: DurablePhotoStore;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAutomaticAttempts: number;
  private readonly listeners = new Set<(snapshot: AppSnapshot) => void>();
  private readonly ready: Promise<void>;
  private readonly networkUnsubscribe: Unsubscribe;

  private queue: QueueEnvelope = clone(EMPTY_QUEUE);
  private persistedQueue: QueueEnvelope = clone(EMPTY_QUEUE);
  private cachedSnapshots: Record<string, AppSnapshot> = {};
  private baseSnapshot: AppSnapshot | null = null;
  private baseUnsubscribe: Unsubscribe | null = null;
  private lock: Promise<void> = Promise.resolve();
  private flushPromise: Promise<void> | null = null;
  private forcedFlushPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOnline: boolean | null = null;
  private activeUserId: string | null = null;
  private sessionEpoch = 0;
  private readonly photoRemovalsAfterCommit = new Set<string>();
  private readonly photoRemovalsAfterRollback = new Set<string>();
  private disposed = false;
  // Bumped only when the durable queue (or the active session) changes, so
  // subscribers can skip re-reading the operation list on data-only syncs.
  private queueRevision = 0;

  constructor(
    private readonly base: AppRepository,
    options: OfflineQueueRepositoryOptions = {},
  ) {
    this.storage = options.storage ?? AsyncStorage;
    this.storageKey = options.storageKey ?? OFFLINE_QUEUE_STORAGE_KEY;
    this.snapshotStorageKey = options.snapshotStorageKey ?? OFFLINE_SNAPSHOT_STORAGE_KEY;
    this.network = options.network ?? createNetInfoMonitor();
    this.photoStore = options.photoStore ?? new ExpoDocumentPhotoStore();
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? makeUuid;
    this.baseBackoffMs = Math.max(100, options.baseBackoffMs ?? 1_000);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, options.maxBackoffMs ?? 60_000);
    this.maxAutomaticAttempts = Math.max(1, options.maxAutomaticAttempts ?? 5);
    this.ready = this.hydrate();
    void this.ready.catch(() => undefined);
    this.networkUnsubscribe = this.network.subscribe((online) => {
      const recovered = online && this.lastOnline !== true;
      this.lastOnline = online;
      if (recovered) void this.startFlush(true).catch(() => undefined);
    });
  }

  /** Invalidates cached state immediately when the authenticated account changes. */
  setActiveUserId(userId: string | null): void {
    if (this.disposed) return;
    if (this.activeUserId === userId) return;
    this.activeUserId = userId;
    this.sessionEpoch += 1;
    // The visible operation set is filtered by user, so a session change alters
    // it even though the durable queue is untouched.
    this.queueRevision += 1;
    this.baseSnapshot = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async load(): Promise<AppSnapshot> {
    const snapshot = await this.withLock(async () => {
      await this.ready;
      const nextSnapshot = await this.loadBaseOrCachedLocked();
      this.baseSnapshot = nextSnapshot;
      const changed = await this.reconcileLocked();
      if (changed) await this.persistLocked();
      this.scheduleRetryLocked();
      return this.composeLocked();
    });
    void this.startFlush(false).catch(() => undefined);
    return clone(snapshot);
  }

  // 프로필은 사진 업로드와 서버 시각 기반 쿨다운을 함께 다루므로 오프라인
  // 재생 대상이 아니다. 성공 뒤에는 읽기 모델을 base와 맞춘다.
  async updateNickname(nickname: string): Promise<Profile> {
    const result = await this.base.updateNickname(nickname);
    await this.syncBaseAfterMutation();
    return result;
  }

  async updateAvatar(input: { avatarKey?: string; photoUri?: string | null }): Promise<Profile> {
    const result = await this.base.updateAvatar(input);
    await this.syncBaseAfterMutation();
    return result;
  }

  async createRoom(input: CreateRoomInput): Promise<Room> {
    const result = await this.base.createRoom(input);
    void this.syncBaseAfterMutation().catch(() => undefined);
    return result;
  }

  // 방 설정은 모든 멤버에게 즉시 보이고 서버가 정원·권한을 판정하므로
  // 오프라인 큐에 넣지 않는다.
  async updateRoomSettings(input: UpdateRoomSettingsInput): Promise<Room> {
    const result = await this.base.updateRoomSettings(input);
    await this.syncBaseAfterMutation();
    return result;
  }

  previewInvite(inviteCode: string): Promise<InvitePreview> {
    return this.base.previewInvite(inviteCode);
  }

  async joinRoom(inviteCode: string, joinedAt?: string): Promise<RoomMember> {
    const result = await this.base.joinRoom(inviteCode, joinedAt);
    void this.syncBaseAfterMutation().catch(() => undefined);
    return result;
  }

  // Leaving and switching settle memberships and hand off ownership, so they
  // run straight through to the server rather than being queued offline.
  async leaveRoom(roomId: string, successorId?: string): Promise<void> {
    await this.base.leaveRoom(roomId, successorId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.base.closeRoom(roomId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async switchRoom(input: SwitchRoomInput): Promise<RoomMember> {
    const result = await this.base.switchRoom(input);
    void this.syncBaseAfterMutation().catch(() => undefined);
    return result;
  }

  // Exception responses settle the exclusion set shared by every member, so they
  // go straight to the server instead of being queued and replayed offline.
  async respondToExpenseException(
    expenseId: string,
    decision: ExpenseExceptionResponseDecision,
  ): Promise<void> {
    await this.base.respondToExpenseException(expenseId, decision);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async withdrawExpenseException(expenseId: string): Promise<void> {
    await this.base.withdrawExpenseException(expenseId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async addExpense(input: AddExpenseInput): Promise<Expense> {
    const result = await this.withLock(async () => {
      await this.ensureBaseLocked();
      const requestId = input.clientRequestId.trim() || this.randomId();
      const duplicate = this.composeLocked().expenses.find(
        (expense) => expense.clientRequestId === requestId,
      );
      if (duplicate) return duplicate;

      const operationId = `expense:add:${requestId}`;
      const photo = await this.persistPhotoLocked(input.photoUri, operationId);
      const timestamp = new Date(this.now()).toISOString();
      const operation: AddExpenseOperation = {
        ...this.newOperationBase('ADD_EXPENSE', operationId, requestId, timestamp),
        deadlineAt: this.expenseDeadline(input.periodId),
        optimisticId: `offline-expense-${hash32(requestId).toString(16)}`,
        input: {
          ...input,
          clientRequestId: requestId,
          photoUri: photo?.uri ?? input.photoUri,
        },
        originalPhotoUri: photo?.originalUri,
        cachedPhotoUri: photo?.owned ? photo.uri : undefined,
        ownsCachedPhoto: photo?.owned,
      };
      try {
        this.queue.operations.push(operation);
        await this.persistLocked();
      } catch (error) {
        this.queue.operations = this.queue.operations.filter((item) => item.id !== operation.id);
        await this.removePhotoImmediately(operation);
        throw error;
      }
      this.emitLocked();
      return requireExpenseById(this.composeLocked(), operation.optimisticId);
    });
    void this.startFlush(false).catch(() => undefined);
    return clone(result);
  }

  async updateExpense(expenseId: string, patch: Partial<AddExpenseInput>): Promise<Expense> {
    const result = await this.withLock(async () => {
      await this.ensureBaseLocked();
      this.assertNoAppliedExpenseCleanupLocked(expenseId);
      const current = requireExpenseById(this.composeLocked(), expenseId);
      const nextPatch = { ...patch };
      if (nextPatch.photoUri === current.photoUri) delete nextPatch.photoUri;
      if (nextPatch.clientRequestId !== undefined && nextPatch.clientRequestId !== current.clientRequestId) {
        throw new OfflineQueueRepositoryError('IMMUTABLE_FIELD', '요청 식별자는 변경할 수 없어요.');
      }

      const pendingAdd = this.queue.operations.find(
        (operation): operation is AddExpenseOperation =>
          operation.kind === 'ADD_EXPENSE' && operation.optimisticId === expenseId,
      );
      if (pendingAdd) {
        await this.replaceOperationPhotoLocked(pendingAdd, nextPatch.photoUri);
        pendingAdd.input = { ...pendingAdd.input, ...nextPatch, clientRequestId: pendingAdd.requestId };
        if (pendingAdd.cachedPhotoUri) pendingAdd.input.photoUri = pendingAdd.cachedPhotoUri;
        this.resetForRetryLocked(pendingAdd);
        await this.persistLocked();
        this.emitLocked();
        return requireExpenseById(this.composeLocked(), expenseId);
      }

      if (this.hasOperation('DELETE_EXPENSE', expenseId)) {
        throw new OfflineQueueRepositoryError('DELETE_PENDING', '삭제 대기 중인 지출은 수정할 수 없어요.');
      }
      let operation = this.queue.operations.find(
        (item): item is UpdateExpenseOperation => item.kind === 'UPDATE_EXPENSE' && item.targetId === expenseId,
      );
      const isNewOperation = !operation;
      if (!operation) {
        const requestId = this.randomId();
        const timestamp = new Date(this.now()).toISOString();
        operation = {
          ...this.newOperationBase('UPDATE_EXPENSE', `expense:update:${requestId}`, requestId, timestamp),
          targetId: expenseId,
          patch: {},
          baseEntity: clone(current),
          baseVersion: current.version,
          deadlineAt: this.expenseDeadline(current.periodId),
        };
      }
      await this.replaceOperationPhotoLocked(operation, nextPatch.photoUri);
      operation.patch = { ...operation.patch, ...nextPatch };
      if (operation.cachedPhotoUri) operation.patch.photoUri = operation.cachedPhotoUri;
      this.resetForRetryLocked(operation);
      if (isNewOperation) this.queue.operations.push(operation);
      await this.persistLocked();
      this.emitLocked();
      return requireExpenseById(this.composeLocked(), expenseId);
    });
    void this.startFlush(false).catch(() => undefined);
    return clone(result);
  }

  async deleteExpense(expenseId: string): Promise<void> {
    await this.withLock(async () => {
      await this.ensureBaseLocked();
      this.assertNoAppliedExpenseCleanupLocked(expenseId);
      const current = requireExpenseById(this.composeLocked(), expenseId);
      const pendingAdd = this.queue.operations.find(
        (operation): operation is AddExpenseOperation =>
          operation.kind === 'ADD_EXPENSE' && operation.optimisticId === expenseId,
      );
      if (pendingAdd) {
        this.queue.operations = this.queue.operations.filter((operation) => operation.id !== pendingAdd.id);
        await this.releasePhotoLocked(pendingAdd);
        await this.persistLocked();
        this.emitLocked();
        return;
      }
      if (this.hasOperation('DELETE_EXPENSE', expenseId)) return;

      const supersededUpdates = this.queue.operations.filter(
        (operation): operation is UpdateExpenseOperation =>
          operation.kind === 'UPDATE_EXPENSE' && operation.targetId === expenseId,
      );
      this.queue.operations = this.queue.operations.filter(
        (operation) => !(operation.kind === 'UPDATE_EXPENSE' && operation.targetId === expenseId),
      );
      const serverBase = supersededUpdates[0]?.baseEntity ?? current;
      for (const operation of supersededUpdates) await this.releasePhotoLocked(operation);

      const requestId = this.randomId();
      const timestamp = new Date(this.now()).toISOString();
      this.queue.operations.push({
        ...this.newOperationBase('DELETE_EXPENSE', `expense:delete:${requestId}`, requestId, timestamp),
        deadlineAt: this.expenseDeadline(serverBase.periodId),
        targetId: expenseId,
        baseEntity: clone(serverBase),
        baseVersion: serverBase.version,
      });
      await this.persistLocked();
      this.emitLocked();
    });
    void this.startFlush(false).catch(() => undefined);
  }

  async deleteArchivedPeriod(periodId: string): Promise<void> {
    await this.withLock(async () => {
      await this.ensureBaseLocked();
      const snapshot = this.composeLocked();
      const expenseIds = new Set(
        snapshot.expenses
          .filter((expense) => expense.periodId === periodId)
          .map((expense) => expense.id),
      );
      const hasPendingMutation = this.queue.operations.some((operation) => (
        (operation.kind === 'ADD_EXPENSE' && operation.input.periodId === periodId)
        || ('targetId' in operation && expenseIds.has(operation.targetId))
        || ('baseEntity' in operation && 'periodId' in operation.baseEntity
          && operation.baseEntity.periodId === periodId)
      ));
      if (hasPendingMutation) {
        throw new OfflineQueueRepositoryError(
          'PERIOD_DELETE_PENDING_MUTATIONS',
          '동기화 대기 중인 지출 또는 댓글이 있어 지난 주차를 삭제할 수 없어요.',
        );
      }
      if (!await this.network.fetch()) {
        throw new OfflineQueueRepositoryError(
          'PERIOD_DELETE_REQUIRES_ONLINE',
          '지난 주차 삭제는 인터넷에 연결된 상태에서만 할 수 있어요.',
        );
      }
      await this.base.deleteArchivedPeriod(periodId);
      this.baseSnapshot = normalizeSnapshot(await this.base.load());
      await this.persistCachedSnapshotLocked(this.baseSnapshot);
      this.emitLocked();
    });
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    const result = await this.withLock(async () => {
      await this.ensureBaseLocked();
      const snapshot = this.composeLocked();
      const expense = requireExpenseById(snapshot, input.expenseId);
      if (expense.syncStatus !== 'SYNCED' || expense.id.startsWith('offline-expense-')) {
        throw new OfflineQueueRepositoryError(
          'PENDING_EXPENSE_COMMENT_BLOCKED',
          '지출 저장이 완료된 뒤 댓글을 남겨 주세요. 오프라인 지출에는 댓글을 연결하지 않아요.',
        );
      }
      const requestId = input.clientRequestId.trim() || this.randomId();
      const duplicate = snapshot.comments.find((comment) => comment.clientRequestId === requestId);
      if (duplicate) return duplicate;
      const timestamp = new Date(this.now()).toISOString();
      const operation: AddCommentOperation = {
        ...this.newOperationBase('ADD_COMMENT', `comment:add:${requestId}`, requestId, timestamp),
        optimisticId: `offline-comment-${hash32(requestId).toString(16)}`,
        input: { ...input, clientRequestId: requestId },
      };
      this.queue.operations.push(operation);
      await this.persistLocked();
      this.emitLocked();
      return requireCommentById(this.composeLocked(), operation.optimisticId);
    });
    void this.startFlush(false).catch(() => undefined);
    return clone(result);
  }

  async updateComment(commentId: string, body: string): Promise<Comment> {
    const result = await this.withLock(async () => {
      await this.ensureBaseLocked();
      const current = requireCommentById(this.composeLocked(), commentId);
      const pendingAdd = this.queue.operations.find(
        (operation): operation is AddCommentOperation =>
          operation.kind === 'ADD_COMMENT' && operation.optimisticId === commentId,
      );
      if (pendingAdd) {
        pendingAdd.input.body = body;
        this.resetForRetryLocked(pendingAdd);
        await this.persistLocked();
        this.emitLocked();
        return requireCommentById(this.composeLocked(), commentId);
      }
      if (this.hasOperation('DELETE_COMMENT', commentId)) {
        throw new OfflineQueueRepositoryError('DELETE_PENDING', '삭제 대기 중인 댓글은 수정할 수 없어요.');
      }
      let operation = this.queue.operations.find(
        (item): item is UpdateCommentOperation => item.kind === 'UPDATE_COMMENT' && item.targetId === commentId,
      );
      if (!operation) {
        const requestId = this.randomId();
        const timestamp = new Date(this.now()).toISOString();
        operation = {
          ...this.newOperationBase('UPDATE_COMMENT', `comment:update:${requestId}`, requestId, timestamp),
          targetId: commentId,
          body,
          baseEntity: clone(current),
          baseVersion: current.version,
        };
        this.queue.operations.push(operation);
      } else {
        operation.body = body;
      }
      this.resetForRetryLocked(operation);
      await this.persistLocked();
      this.emitLocked();
      return requireCommentById(this.composeLocked(), commentId);
    });
    void this.startFlush(false).catch(() => undefined);
    return clone(result);
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.withLock(async () => {
      await this.ensureBaseLocked();
      const current = requireCommentById(this.composeLocked(), commentId);
      const pendingAdd = this.queue.operations.find(
        (operation): operation is AddCommentOperation =>
          operation.kind === 'ADD_COMMENT' && operation.optimisticId === commentId,
      );
      if (pendingAdd) {
        this.queue.operations = this.queue.operations.filter((operation) => operation.id !== pendingAdd.id);
        await this.persistLocked();
        this.emitLocked();
        return;
      }
      if (this.hasOperation('DELETE_COMMENT', commentId)) return;
      this.queue.operations = this.queue.operations.filter(
        (operation) => !(operation.kind === 'UPDATE_COMMENT' && operation.targetId === commentId),
      );
      const requestId = this.randomId();
      const timestamp = new Date(this.now()).toISOString();
      this.queue.operations.push({
        ...this.newOperationBase('DELETE_COMMENT', `comment:delete:${requestId}`, requestId, timestamp),
        targetId: commentId,
        baseEntity: clone(current),
        baseVersion: current.version,
      });
      await this.persistLocked();
      this.emitLocked();
    });
    void this.startFlush(false).catch(() => undefined);
  }

  // 반응은 멱등 토글의 최신 서버 상태가 필요해 오프라인 큐에 넣지 않는다.
  async toggleCommentReaction(
    commentId: string,
    emoji: CommentReactionEmoji,
  ): Promise<void> {
    await this.base.toggleCommentReaction(commentId, emoji);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  // 커뮤니티는 사진·마감 의존이 없는 저빈도 상호작용이라 오프라인 큐에 쌓지 않는다.
  // 서버의 최신 권한과 순서를 바로 반영한 뒤 스냅샷만 갱신한다.
  async addRoomPost(input: AddRoomPostInput): Promise<RoomPost> {
    const post = await this.base.addRoomPost(input);
    void this.syncBaseAfterMutation().catch(() => undefined);
    return post;
  }

  async updateRoomPost(input: UpdateRoomPostInput): Promise<RoomPost> {
    const post = await this.base.updateRoomPost(input);
    void this.syncBaseAfterMutation().catch(() => undefined);
    return post;
  }

  async deleteRoomPost(postId: string): Promise<void> {
    await this.base.deleteRoomPost(postId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async addRoomPostComment(input: AddRoomPostCommentInput): Promise<RoomPostComment> {
    const comment = await this.base.addRoomPostComment(input);
    void this.syncBaseAfterMutation().catch(() => undefined);
    return comment;
  }

  async updateRoomPostComment(commentId: string, body: string): Promise<RoomPostComment> {
    const comment = await this.base.updateRoomPostComment(commentId, body);
    void this.syncBaseAfterMutation().catch(() => undefined);
    return comment;
  }

  async deleteRoomPostComment(commentId: string): Promise<void> {
    await this.base.deleteRoomPostComment(commentId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async toggleRoomPostReaction(postId: string, emoji: RoomPostReactionEmoji): Promise<void> {
    await this.base.toggleRoomPostReaction(postId, emoji);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async markExpenseRead(expenseId: string): Promise<void> {
    await this.base.markExpenseRead(expenseId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async markRoomPostRead(postId: string): Promise<void> {
    await this.base.markRoomPostRead(postId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async voteRoomPostPoll(postId: string, optionId: string): Promise<void> {
    await this.base.voteRoomPostPoll(postId, optionId);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  // 읽음 처리는 서버의 사용자별 상태만 바꾸므로 오프라인 큐에 재생하지 않는다.
  // 다음 동기화에서 받은 스냅샷이 최종 상태다.
  async markNotificationsRead(notificationIds: readonly string[]): Promise<void> {
    if (notificationIds.length === 0) return;
    await this.base.markNotificationsRead(notificationIds);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.base.markAllNotificationsRead();
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  async sendWinnerNudge(input: { roomId: string; body: string }): Promise<void> {
    await this.base.sendWinnerNudge(input);
    void this.syncBaseAfterMutation().catch(() => undefined);
  }

  subscribe(listener: (snapshot: AppSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    this.ensureBaseSubscription();
    if (this.baseSnapshot && this.isCurrentSessionSnapshot(this.baseSnapshot)) {
      listener(clone(this.composeLocked()));
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.baseUnsubscribe) {
        this.baseUnsubscribe();
        this.baseUnsubscribe = null;
      }
    };
  }

  /** Forces all currently pending operations to ignore their backoff deadline once. */
  flushNow(): Promise<void> {
    return this.startFlush(true);
  }

  async retryOperation(operationId: string): Promise<void> {
    const shouldFlush = await this.withLock(async () => {
      await this.ready;
      const operation = this.queue.operations.find((item) => item.id === operationId);
      const userId = this.currentUserId();
      if (!operation || !userId || operation.userId !== userId) {
        throw new OfflineQueueRepositoryError('QUEUE_ITEM_NOT_FOUND', '재시도할 작업을 찾지 못했어요.');
      }
      if (operation.status !== 'FAILED') return false;
      if (operation.failure?.code === 'CUTOFF_EXPIRED' || isExpired(operation.deadlineAt, this.now())) {
        this.markCutoffExpiredLocked(operation);
        await this.persistLocked();
        this.emitLocked();
        throw new OfflineQueueRepositoryError(
          'CUTOFF_EXPIRED',
          '지출 보정 마감이 지나 이 작업은 결과에 다시 반영할 수 없어요.',
        );
      }

      const epoch = this.sessionEpoch;
      const nextSnapshot = normalizeSnapshot(await this.base.load());
      this.assertCurrentSessionSnapshot(nextSnapshot, epoch);
      this.baseSnapshot = nextSnapshot;
      await this.persistCachedSnapshotLocked(nextSnapshot);
      this.assertCurrentSessionSnapshot(nextSnapshot, epoch);
      if (operation.failure?.code === 'VERSION_CONFLICT') {
        const rebased = await this.rebaseConflictLocked(operation);
        if (!rebased) {
          await this.persistLocked();
          this.emitLocked();
          return false;
        }
      }
      if (operation.originalPhotoUri && !operation.cachedPhotoUri) {
        const persisted = await this.photoStore.persist(operation.originalPhotoUri, operation.id);
        operation.cachedPhotoUri = persisted.owned ? persisted.uri : undefined;
        operation.ownsCachedPhoto = persisted.owned;
        applyPhotoUri(operation, persisted.uri);
      }
      this.resetForRetryLocked(operation);
      await this.persistLocked();
      this.emitLocked();
      return true;
    });
    if (shouldFlush) await this.startFlush(true);
  }

  async discardOperation(operationId: string): Promise<void> {
    await this.withLock(async () => {
      await this.ready;
      const userId = this.currentUserId();
      const operation = this.queue.operations.find((item) => item.id === operationId);
      if (!operation || !userId || operation.userId !== userId) {
        throw new OfflineQueueRepositoryError('QUEUE_ITEM_NOT_FOUND', '삭제할 작업을 찾지 못했어요.');
      }
      if (operation.status !== 'FAILED') {
        throw new OfflineQueueRepositoryError('QUEUE_ITEM_PENDING', '동기화 중인 작업은 삭제할 수 없어요.');
      }
      this.queue.operations = this.queue.operations.filter((item) => item.id !== operation.id);
      await this.releasePhotoLocked(operation);
      await this.persistLocked();
      this.emitLocked();
    });
  }

  /** Permanently removes one account's offline records after server-side deletion. */
  async clearDeletedUserData(userId: string): Promise<void> {
    await this.withLock(async () => {
      await this.ready;
      const deletedOperations = this.queue.operations.filter(
        (operation) => operation.userId === userId,
      );
      this.queue.operations = this.queue.operations.filter(
        (operation) => operation.userId !== userId,
      );
      for (const operation of deletedOperations) await this.releasePhotoLocked(operation);

      delete this.cachedSnapshots[userId];
      if (this.baseSnapshot?.currentUserId === userId) this.baseSnapshot = null;
      if (this.activeUserId === userId) {
        this.activeUserId = null;
        this.sessionEpoch += 1;
      }
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;

      await this.persistLocked();
      const envelope: SnapshotEnvelope = {
        schemaVersion: 1,
        snapshots: this.cachedSnapshots,
      };
      try {
        if (Object.keys(this.cachedSnapshots).length === 0) {
          await this.storage.removeItem(this.snapshotStorageKey);
        } else {
          await this.storage.setItem(this.snapshotStorageKey, JSON.stringify(envelope));
        }
      } catch {
        // The account is already gone on the server. A stale display cache is
        // never used while signed out, and the next successful write replaces it.
      }
    });
  }

  /**
   * Monotonic counter that changes only when the queue or active session does.
   * Subscribers compare it to skip re-reading operations on data-only syncs.
   */
  getQueueRevision(): number {
    return this.queueRevision;
  }

  async getQueueOperations(): Promise<OfflineMutationSummary[]> {
    await this.ready;
    const userId = this.currentUserId();
    if (!userId) return [];
    return this.queue.operations
      .filter((operation) => operation.userId === userId)
      .sort(compareOperations)
      .map(toSummary);
  }

  async getCopyableError(operationId: string): Promise<string | null> {
    await this.ready;
    const userId = this.currentUserId();
    if (!userId) return null;
    return this.queue.operations.find(
      (operation) => operation.id === operationId && operation.userId === userId,
    )?.failure?.copyableMessage ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.activeUserId = null;
    this.sessionEpoch += 1;
    this.baseSnapshot = null;
    this.listeners.clear();
    this.baseUnsubscribe?.();
    this.baseUnsubscribe = null;
    this.networkUnsubscribe();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async hydrate(): Promise<void> {
    const snapshotRead = this.storage.getItem(this.snapshotStorageKey).catch(() => null);
    const [rawQueue, rawSnapshots] = await Promise.all([
      this.storage.getItem(this.storageKey),
      snapshotRead,
    ]);
    if (rawQueue) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawQueue);
      } catch (error) {
        throw new OfflineQueueRepositoryError(
          'QUEUE_STORAGE_CORRUPT',
          '저장된 오프라인 작업을 읽지 못했어요. 원본 데이터는 삭제하지 않았습니다.',
          { cause: error },
        );
      }
      if (!isQueueEnvelope(parsed)) {
        throw new OfflineQueueRepositoryError(
          'QUEUE_STORAGE_UNSUPPORTED',
          '저장된 오프라인 작업 형식을 지원하지 않아요. 원본 데이터는 삭제하지 않았습니다.',
        );
      }
      this.queue = parsed;
      this.queue.operations.sort(compareOperations);
      this.queue.nextSequence = Math.max(
        this.queue.nextSequence,
        ...this.queue.operations.map((operation) => operation.sequence + 1),
      );
      this.persistedQueue = clone(this.queue);
    }
    if (rawSnapshots) {
      try {
        const parsed = JSON.parse(rawSnapshots) as unknown;
        if (isSnapshotEnvelope(parsed)) this.cachedSnapshots = parsed.snapshots;
      } catch {
        // A corrupt display cache must never destroy or block the mutation queue.
      }
    }
  }

  private async ensureBaseLocked(): Promise<void> {
    await this.ready;
    if (this.baseSnapshot && this.isCurrentSessionSnapshot(this.baseSnapshot)) return;
    this.baseSnapshot = await this.loadBaseOrCachedLocked();
  }

  private async loadBaseOrCachedLocked(): Promise<AppSnapshot> {
    const epoch = this.sessionEpoch;
    try {
      const snapshot = normalizeSnapshot(await this.base.load());
      this.assertCurrentSessionSnapshot(snapshot, epoch);
      await this.persistCachedSnapshotLocked(snapshot);
      this.assertCurrentSessionSnapshot(snapshot, epoch);
      return snapshot;
    } catch (error) {
      if (!canUseCachedSnapshot(error)) throw error;
      const userId = this.currentUserId();
      const cached = userId ? this.cachedSnapshots[userId] : undefined;
      if (!cached) throw error;
      const snapshot = normalizeSnapshot(cached);
      this.assertCurrentSessionSnapshot(snapshot, epoch);
      return snapshot;
    }
  }

  private async persistCachedSnapshotLocked(snapshot: AppSnapshot): Promise<void> {
    const sanitized = sanitizeCachedSnapshot(snapshot);
    this.cachedSnapshots = {
      ...this.cachedSnapshots,
      [sanitized.currentUserId]: sanitized,
    };
    const envelope: SnapshotEnvelope = {
      schemaVersion: 1,
      snapshots: this.cachedSnapshots,
    };
    try {
      await this.storage.setItem(this.snapshotStorageKey, JSON.stringify(envelope));
    } catch {
      // This cache only restores the read model. A cache write must never roll
      // back or block the independently durable mutation queue.
    }
  }

  private ensureBaseSubscription(): void {
    if (this.baseUnsubscribe) return;
    this.baseUnsubscribe = this.base.subscribe((snapshot) => {
      void this.withLock(async () => {
        await this.ready;
        const nextSnapshot = normalizeSnapshot(snapshot);
        if (!this.isCurrentSessionSnapshot(nextSnapshot)) return;
        this.baseSnapshot = nextSnapshot;
        await this.persistCachedSnapshotLocked(nextSnapshot);
        const changed = await this.reconcileLocked();
        if (changed) await this.persistLocked();
        this.scheduleRetryLocked();
        this.emitLocked();
      }).then(
        () => this.startFlush(false).catch(() => undefined),
        () => undefined,
      );
    });
  }

  private async refreshBase(): Promise<void> {
    await this.withLock(async () => {
      await this.ready;
      const nextSnapshot = await this.loadBaseOrCachedLocked();
      this.baseSnapshot = nextSnapshot;
      const changed = await this.reconcileLocked();
      if (changed) await this.persistLocked();
      this.emitLocked();
    });
  }

  /**
   * 큐를 거치지 않고 서버로 바로 나간 뮤테이션 뒤에 읽기 모델을 맞춘다.
   *
   * base 저장소는 뮤테이션이 끝나기 전에 갱신된 스냅샷을 리스너로 밀어 준다.
   * 그 알림 처리 작업은 이 시점에 이미 락에 걸려 있으므로, 락이 비기를 기다린
   * 뒤 baseSnapshot이 실제로 교체됐는지 본다. 교체됐다면 같은 데이터를 위해
   * 서버를 한 번 더 왕복할 이유가 없다. 알림이 없었을 때(구독 없음, 세션 불일치
   * 로 무시됨, 알리지 않는 base 구현)만 직접 읽어 온다.
   */
  private async syncBaseAfterMutation(): Promise<void> {
    if (!this.baseUnsubscribe) {
      await this.refreshBase();
      return;
    }
    const snapshotBeforeNotification = this.baseSnapshot;
    await this.withLock(async () => undefined);
    if (this.baseSnapshot !== snapshotBeforeNotification) return;
    await this.refreshBase();
  }

  private newOperationBase<K extends MutationKind>(
    kind: K,
    id: string,
    requestId: string,
    timestamp: string,
  ): OperationBase & { kind: K } {
    if (!this.baseSnapshot) throw new OfflineQueueRepositoryError('SNAPSHOT_REQUIRED', '앱 데이터를 먼저 불러와 주세요.');
    this.assertCurrentSessionSnapshot(this.baseSnapshot);
    return {
      id,
      requestId,
      kind,
      userId: this.baseSnapshot.currentUserId,
      status: 'PENDING',
      sequence: this.queue.nextSequence++,
      attempts: 0,
      enqueuedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private async persistPhotoLocked(
    uri: string | undefined,
    operationId: string,
  ): Promise<(PersistedPhoto & { originalUri: string }) | undefined> {
    if (!uri) return undefined;
    const persisted = await this.photoStore.persist(uri, operationId);
    if (persisted.owned) this.photoRemovalsAfterRollback.add(persisted.uri);
    return { ...persisted, originalUri: uri };
  }

  private async replaceOperationPhotoLocked(
    operation: AddExpenseOperation | UpdateExpenseOperation,
    nextUri: string | undefined,
  ): Promise<void> {
    if (nextUri === undefined) return;
    const previousCached = operation.cachedPhotoUri;
    const previousOwned = operation.ownsCachedPhoto;
    if (!nextUri) {
      operation.originalPhotoUri = nextUri;
      operation.cachedPhotoUri = undefined;
      operation.ownsCachedPhoto = false;
    } else if (nextUri !== operation.originalPhotoUri && nextUri !== previousCached) {
      const persisted = await this.photoStore.persist(nextUri, operation.id);
      if (persisted.owned) this.photoRemovalsAfterRollback.add(persisted.uri);
      operation.originalPhotoUri = nextUri;
      operation.cachedPhotoUri = persisted.owned ? persisted.uri : undefined;
      operation.ownsCachedPhoto = persisted.owned;
      operation.photoRevision = (operation.photoRevision ?? 0) + 1;
      applyPhotoUri(operation, persisted.uri);
    }
    if (previousOwned && previousCached && previousCached !== operation.cachedPhotoUri) {
      this.photoRemovalsAfterCommit.add(previousCached);
    }
  }

  private async releasePhotoLocked(operation: MutationOperation): Promise<void> {
    if (operation.ownsCachedPhoto && operation.cachedPhotoUri) {
      this.photoRemovalsAfterCommit.add(operation.cachedPhotoUri);
      if (operation.originalPhotoUri !== undefined) applyPhotoUri(operation, operation.originalPhotoUri);
    }
    operation.cachedPhotoUri = undefined;
    operation.ownsCachedPhoto = false;
  }

  private async removePhotoImmediately(operation: MutationOperation): Promise<void> {
    if (operation.ownsCachedPhoto && operation.cachedPhotoUri) {
      this.photoRemovalsAfterRollback.delete(operation.cachedPhotoUri);
      await safelyRemove(this.photoStore, operation.cachedPhotoUri);
    }
    operation.cachedPhotoUri = undefined;
    operation.ownsCachedPhoto = false;
  }

  private resetForRetryLocked(operation: MutationOperation): void {
    operation.status = 'PENDING';
    operation.attempts = 0;
    operation.nextAttemptAt = undefined;
    operation.failure = undefined;
    operation.updatedAt = new Date(this.now()).toISOString();
  }

  private currentUserId(): string | null {
    return this.activeUserId;
  }

  private isCurrentSessionSnapshot(snapshot: AppSnapshot, epoch = this.sessionEpoch): boolean {
    return epoch === this.sessionEpoch &&
      this.activeUserId !== null &&
      snapshot.currentUserId === this.activeUserId;
  }

  private assertCurrentSessionSnapshot(snapshot: AppSnapshot, epoch = this.sessionEpoch): void {
    if (!this.isCurrentSessionSnapshot(snapshot, epoch)) {
      throw new OfflineQueueRepositoryError(
        'SESSION_CHANGED',
        '로그인 사용자가 바뀌었어요. 현재 계정의 데이터를 다시 불러와 주세요.',
      );
    }
  }

  /**
   * §7 오프라인 주차 전환 규칙: 지출은 큐에 담길 때의 주차(period)에 귀속되고,
   * 그 주차의 보정 마감(C = 토 12:00 KST)이 서버 확인 전에 지나면
   * CUTOFF_EXPIRED로 확정 실패 처리한다. 다음 주차로 이월하지 않는다.
   */
  private expenseDeadline(periodId: string | undefined): string | undefined {
    if (!periodId || !this.baseSnapshot) return undefined;
    const period = this.baseSnapshot.periods.find((item) => item.id === periodId);
    if (!period) return undefined;
    return new Date(createPeriodTimeline(period.weekStart).C).toISOString();
  }

  private async rebaseConflictLocked(operation: MutationOperation): Promise<boolean> {
    if (!this.baseSnapshot || operation.kind === 'ADD_EXPENSE' || operation.kind === 'ADD_COMMENT') {
      return true;
    }
    if (operation.kind === 'UPDATE_EXPENSE' || operation.kind === 'DELETE_EXPENSE') {
      const remote = this.baseSnapshot.expenses.find((expense) => expense.id === operation.targetId);
      if (!remote || remote.deletedAt) {
        if (operation.kind === 'DELETE_EXPENSE') {
          this.queue.operations = this.queue.operations.filter((item) => item.id !== operation.id);
          await this.releasePhotoLocked(operation);
          return false;
        }
        throw new OfflineQueueRepositoryError('NOT_FOUND', '최신 지출 기록을 찾을 수 없어 변경을 다시 적용할 수 없어요.');
      }
      operation.baseEntity = clone(remote);
      operation.baseVersion = remote.version;
      operation.deadlineAt = this.expenseDeadline(remote.periodId);
      return true;
    }
    const remote = this.baseSnapshot.comments.find((comment) => comment.id === operation.targetId);
    if (!remote || remote.deletedAt) {
      if (operation.kind === 'DELETE_COMMENT') {
        this.queue.operations = this.queue.operations.filter((item) => item.id !== operation.id);
        await this.releasePhotoLocked(operation);
        return false;
      }
      throw new OfflineQueueRepositoryError('NOT_FOUND', '최신 댓글을 찾을 수 없어 변경을 다시 적용할 수 없어요.');
    }
    operation.baseEntity = clone(remote);
    operation.baseVersion = remote.version;
    return true;
  }

  private hasOperation(kind: MutationKind, targetId: string): boolean {
    return this.queue.operations.some(
      (operation) => operation.kind === kind && 'targetId' in operation && operation.targetId === targetId,
    );
  }

  private assertNoAppliedExpenseCleanupLocked(expenseId: string): void {
    const cleanupPending = this.queue.operations.some((operation) =>
      operation.serverApplied === true &&
      (operation.kind === 'UPDATE_EXPENSE' || operation.kind === 'DELETE_EXPENSE') &&
      operation.targetId === expenseId,
    );
    if (cleanupPending) {
      throw new OfflineQueueRepositoryError(
        'PHOTO_CLEANUP_PENDING',
        '이전 사진 정리를 마친 뒤 이 지출을 다시 변경해 주세요.',
      );
    }
  }

  private composeLocked(): AppSnapshot {
    const baseSnapshot = this.baseSnapshot;
    if (!baseSnapshot) {
      throw new OfflineQueueRepositoryError('SNAPSHOT_REQUIRED', '앱 데이터를 먼저 불러와 주세요.');
    }
    this.assertCurrentSessionSnapshot(baseSnapshot);
    const operations = this.queue.operations
      .filter((operation) => operation.userId === baseSnapshot.currentUserId)
      .sort(compareOperations);
    if (operations.every((operation) => operation.serverApplied)) return baseSnapshot;
    // Projection only mutates expense/comment collections. Keep every other
    // collection shared with the immutable server snapshot, then clone once at
    // the subscriber boundary below.
    const snapshot: AppSnapshot = {
      ...baseSnapshot,
      expenses: [...baseSnapshot.expenses],
      comments: [...baseSnapshot.comments],
    };

    for (const operation of operations) {
      if (operation.serverApplied) continue;
      const syncStatus = operation.status;
      if (operation.kind === 'ADD_EXPENSE') {
        if (snapshot.expenses.some((expense) => expense.clientRequestId === operation.requestId)) continue;
        snapshot.expenses.unshift({
          id: operation.optimisticId,
          clientRequestId: operation.requestId,
          periodId: operation.input.periodId,
          userId: operation.userId,
          amount: operation.input.amount,
          pointAmount: operation.input.pointAmount,
          category: operation.input.category,
          memo: operation.input.memo,
          photoUri: operation.input.photoUri,
          occurredAt: operation.input.occurredAt,
          createdAt: operation.enqueuedAt,
          updatedAt: operation.updatedAt,
          syncStatus,
          syncOperation: 'ADD',
        });
      } else if (operation.kind === 'UPDATE_EXPENSE') {
        const serverEntity = snapshot.expenses.find((expense) => expense.id === operation.targetId)
          ?? operation.baseEntity;
        replaceExpenseProjection(snapshot.expenses, {
          ...operation.baseEntity,
          ...snapshot.expenses.find((expense) => expense.id === operation.targetId),
          ...operation.patch,
          id: operation.targetId,
          clientRequestId: operation.baseEntity.clientRequestId,
          updatedAt: operation.updatedAt,
          syncStatus,
          syncOperation: 'UPDATE',
          serverAmount: serverEntity.amount,
          serverCategory: serverEntity.category,
        });
      } else if (operation.kind === 'DELETE_EXPENSE') {
        const current = snapshot.expenses.find((expense) => expense.id === operation.targetId) ?? operation.baseEntity;
        replaceExpenseProjection(snapshot.expenses, {
          ...current,
          deletedAt: operation.status === 'PENDING' ? operation.updatedAt : current.deletedAt,
          updatedAt: operation.updatedAt,
          syncStatus,
          syncOperation: 'DELETE',
          serverAmount: current.amount,
          serverCategory: current.category,
        });
      } else if (operation.kind === 'ADD_COMMENT') {
        if (snapshot.comments.some((comment) => comment.clientRequestId === operation.requestId)) continue;
        snapshot.comments.push({
          id: operation.optimisticId,
          clientRequestId: operation.requestId,
          expenseId: operation.input.expenseId,
          userId: operation.userId,
          body: operation.input.body,
          replyToId: operation.input.replyToId,
          createdAt: operation.enqueuedAt,
          updatedAt: operation.updatedAt,
          syncStatus,
        });
        snapshot.commentMentions.push(
          ...(operation.input.mentions ?? []).map((mention) => ({
            ...mention,
            commentId: operation.optimisticId,
          })),
        );
      } else if (operation.kind === 'UPDATE_COMMENT') {
        upsertComment(snapshot.comments, {
          ...operation.baseEntity,
          ...snapshot.comments.find((comment) => comment.id === operation.targetId),
          id: operation.targetId,
          body: operation.body,
          updatedAt: operation.updatedAt,
          syncStatus,
        });
        snapshot.commentMentions = snapshot.commentMentions.filter(
          (mention) => mention.commentId !== operation.targetId,
        );
      } else {
        const current = snapshot.comments.find((comment) => comment.id === operation.targetId) ?? operation.baseEntity;
        upsertComment(snapshot.comments, {
          ...current,
          body: operation.status === 'PENDING' ? '삭제된 메시지입니다.' : current.body,
          deletedAt: operation.status === 'PENDING' ? operation.updatedAt : current.deletedAt,
          updatedAt: operation.updatedAt,
          syncStatus,
        });
        snapshot.commentMentions = snapshot.commentMentions.filter(
          (mention) => mention.commentId !== operation.targetId,
        );
      }
    }
    snapshot.expenses = dedupeVersioned(snapshot.expenses);
    snapshot.comments = dedupeVersioned(snapshot.comments);
    return snapshot;
  }

  private async reconcileLocked(): Promise<boolean> {
    if (!this.baseSnapshot) return false;
    const snapshot = this.baseSnapshot;
    const processed = new Set(snapshot.processedRequestIds);
    const removed = new Set<string>();
    let changed = false;

    for (const operation of this.queue.operations) {
      if (operation.userId !== snapshot.currentUserId) continue;
      if (operation.serverApplied) {
        if (!operation.cleanupPhotoPath) removed.add(operation.id);
        continue;
      }
      if (isExpenseOperation(operation) && !operation.deadlineAt) {
        operation.deadlineAt = this.expenseDeadline(expensePeriodId(operation));
        if (operation.deadlineAt) changed = true;
      }
      if (operation.kind === 'ADD_EXPENSE') {
        const remote = snapshot.expenses.find(
          (expense) => expense.userId === operation.userId && expense.clientRequestId === operation.requestId,
        );
        if (remote || processed.has(operation.requestId)) removed.add(operation.id);
      } else if (operation.kind === 'ADD_COMMENT') {
        const remote = snapshot.comments.find(
          (comment) => comment.userId === operation.userId && comment.clientRequestId === operation.requestId,
        );
        if (remote || processed.has(operation.requestId)) removed.add(operation.id);
      } else if (operation.kind === 'UPDATE_EXPENSE') {
        const remote = snapshot.expenses.find((expense) => expense.id === operation.targetId);
        if (remote && expensePatchMatches(
          remote,
          operation.patch,
          expectedUpdatePhotoPath(operation),
        )) {
          const cleanupPath = replacedExpensePhotoPath(operation, remote);
          if (cleanupPath) {
            operation.serverApplied = true;
            operation.cleanupPhotoPath = cleanupPath;
            this.resetForRetryLocked(operation);
            changed = true;
          } else {
            removed.add(operation.id);
          }
        }
        else if (hasAdvancedVersion(remote, operation.baseVersion)) {
          await this.markConflictLocked(operation);
          changed = true;
        }
      } else if (operation.kind === 'UPDATE_COMMENT') {
        const remote = snapshot.comments.find((comment) => comment.id === operation.targetId);
        if (remote?.body === operation.body) removed.add(operation.id);
        else if (hasAdvancedVersion(remote, operation.baseVersion)) {
          await this.markConflictLocked(operation);
          changed = true;
        }
      } else if (operation.kind === 'DELETE_EXPENSE') {
        const remote = snapshot.expenses.find((expense) => expense.id === operation.targetId);
        if (remote?.deletedAt || (!remote && operation.attempts > 0)) {
          if (operation.baseEntity.photoPath) {
            operation.serverApplied = true;
            operation.cleanupPhotoPath = operation.baseEntity.photoPath;
            this.resetForRetryLocked(operation);
            changed = true;
          } else {
            removed.add(operation.id);
          }
        }
        else if (hasAdvancedVersion(remote, operation.baseVersion)) {
          await this.markConflictLocked(operation);
          changed = true;
        }
      } else {
        const remote = snapshot.comments.find((comment) => comment.id === operation.targetId);
        if (remote?.deletedAt || (!remote && operation.attempts > 0)) removed.add(operation.id);
        else if (hasAdvancedVersion(remote, operation.baseVersion)) {
          await this.markConflictLocked(operation);
          changed = true;
        }
      }
    }

    if (removed.size > 0) {
      const completed = this.queue.operations.filter((operation) => removed.has(operation.id));
      this.queue.operations = this.queue.operations.filter((operation) => !removed.has(operation.id));
      for (const operation of completed) await this.releasePhotoLocked(operation);
      changed = true;
    }
    return changed;
  }

  private async markConflictLocked(operation: MutationOperation): Promise<void> {
    if (operation.status === 'FAILED' && operation.failure?.code === 'VERSION_CONFLICT') return;
    operation.status = 'FAILED';
    operation.nextAttemptAt = undefined;
    operation.updatedAt = new Date(this.now()).toISOString();
    operation.failure = failureFor(
      operation,
      'VERSION_CONFLICT',
      '다른 기기에서 먼저 수정했어요. 최신 기록을 확인한 뒤 다시 시도해 주세요.',
      this.now(),
      true,
    );
  }

  private async startFlush(ignoreBackoff: boolean): Promise<void> {
    if (this.disposed) return;
    await this.ready;
    if (ignoreBackoff) {
      if (this.forcedFlushPromise) return this.forcedFlushPromise;
      const forced = (async () => {
        if (this.flushPromise) await this.flushPromise;
        await this.runSingleFlush(true);
      })();
      this.forcedFlushPromise = forced;
      try {
        await forced;
      } finally {
        if (this.forcedFlushPromise === forced) this.forcedFlushPromise = null;
      }
      return;
    }
    await this.runSingleFlush(false);
  }

  private async runSingleFlush(ignoreBackoff: boolean): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    const current = this.withLock(() => this.flushLocked(ignoreBackoff));
    this.flushPromise = current;
    try {
      await current;
    } finally {
      if (this.flushPromise === current) this.flushPromise = null;
    }
  }

  private async flushLocked(ignoreBackoff: boolean): Promise<void> {
    if (this.disposed) return;
    const expired = await this.finalizeExpiredExpenseOperationsLocked();
    if (expired) {
      await this.persistLocked();
      this.emitLocked();
    }
    const activeUserId = this.currentUserId();
    if (!activeUserId) return;
    // 재생할 작업이 없으면 재생 전 재조회로 확인할 것도 없다. 이 경로는 base가
    // 알림으로 최신 스냅샷을 막 건네준 직후에도(모든 emit이 flush를 부른다)
    // 매번 전체 스냅샷을 한 번 더 읽고 있었다.
    if (!this.queue.operations.some((operation) => operation.userId === activeUserId)) return;
    if (!(await this.network.fetch().catch(() => false))) {
      this.scheduleRetryLocked();
      return;
    }
    // Re-read before replay so a response-lost mutation or a newer Realtime
    // version is reconciled instead of being applied a second time.
    const epoch = this.sessionEpoch;
    try {
      const nextSnapshot = normalizeSnapshot(await this.base.load());
      this.assertCurrentSessionSnapshot(nextSnapshot, epoch);
      this.baseSnapshot = nextSnapshot;
      await this.persistCachedSnapshotLocked(nextSnapshot);
      this.assertCurrentSessionSnapshot(nextSnapshot, epoch);
    } catch {
      // Never replay against a stale snapshot or a session whose identity
      // cannot be freshly verified. The durable queue remains untouched.
      this.scheduleRetryLocked();
      return;
    }
    const reconciled = await this.reconcileLocked();
    const expiredAfterRefresh = await this.finalizeExpiredExpenseOperationsLocked();
    if (reconciled || expiredAfterRefresh) await this.persistLocked();
    if (expiredAfterRefresh) this.emitLocked();
    const userId = this.baseSnapshot?.currentUserId;
    if (!userId) return;
    // 닉네임 중복으로 막힌 방에서는 서버가 지출·댓글 쓰기를 모두 거절한다. 그대로
    // 재생하면 쌓아 둔 변경이 자동 재시도 횟수만 태우고 실패로 남는다. 큐는 손대지
    // 않고 이번 회차만 건너뛴다. 방금 위에서 새로 읽은 스냅샷으로 판단하므로,
    // 닉네임을 바꿔 표시가 풀리면 그 스냅샷 알림이 다시 flush를 부른다.
    if (isNicknameChangeRequired(this.baseSnapshot)) return;

    while (true) {
      const operation = this.queue.operations
        .filter((item) => item.userId === userId && item.status === 'PENDING')
        .sort(compareOperations)[0];
      if (!operation) break;
      if (!ignoreBackoff && operation.nextAttemptAt && Date.parse(operation.nextAttemptAt) > this.now()) break;

      operation.attempts += 1;
      operation.updatedAt = new Date(this.now()).toISOString();
      operation.nextAttemptAt = undefined;
      await this.persistLocked();
      this.emitLocked();

      try {
        await this.executeLocked(operation, epoch);
        if (epoch !== this.sessionEpoch || this.currentUserId() !== operation.userId) return;
        this.queue.operations = this.queue.operations.filter((item) => item.id !== operation.id);
        await this.releasePhotoLocked(operation);
        await this.persistLocked();
        this.emitLocked();
      } catch (error) {
        if (epoch !== this.sessionEpoch || this.currentUserId() !== operation.userId) return;
        const classification = classifyError(error);
        const exhausted = operation.attempts >= this.maxAutomaticAttempts;
        if (classification.permanent || exhausted) {
          const code = exhausted && !classification.permanent ? 'RETRY_EXHAUSTED' : classification.code;
          const message = exhausted && !classification.permanent
            ? `${classification.message} 자동 재시도 횟수를 모두 사용했어요.`
            : classification.message;
          operation.status = 'FAILED';
          operation.nextAttemptAt = undefined;
          operation.failure = failureFor(operation, code, message, this.now(), classification.permanent);
          await this.persistLocked();
          this.emitLocked();
          continue;
        }
        const delay = Math.min(
          this.maxBackoffMs,
          this.baseBackoffMs * 2 ** Math.max(0, operation.attempts - 1),
        );
        operation.nextAttemptAt = new Date(this.now() + delay).toISOString();
        operation.failure = failureFor(
          operation,
          classification.code,
          classification.message,
          this.now(),
          false,
        );
        await this.persistLocked();
        this.emitLocked();
        break;
      }
    }
    this.scheduleRetryLocked();
  }

  private async finalizeExpiredExpenseOperationsLocked(): Promise<boolean> {
    const userId = this.currentUserId();
    if (!userId) return false;
    let changed = false;
    for (const operation of this.queue.operations) {
      if (
        operation.userId !== userId ||
        !isExpenseOperation(operation) ||
        operation.serverApplied === true ||
        operation.failure?.code === 'CUTOFF_EXPIRED' ||
        !isExpired(operation.deadlineAt, this.now())
      ) {
        continue;
      }
      this.markCutoffExpiredLocked(operation);
      changed = true;
    }
    return changed;
  }

  private markCutoffExpiredLocked(operation: MutationOperation): void {
    operation.status = 'FAILED';
    operation.nextAttemptAt = undefined;
    operation.updatedAt = new Date(this.now()).toISOString();
    operation.failure = failureFor(
      operation,
      'CUTOFF_EXPIRED',
      '지출 보정 마감 전에 서버가 확인하지 못해 최종 결과에서 제외됐어요.',
      this.now(),
      true,
    );
  }

  private async executeLocked(operation: MutationOperation, epoch: number): Promise<void> {
    const snapshot = this.baseSnapshot;
    if (!snapshot) throw new OfflineQueueRepositoryError('SNAPSHOT_REQUIRED', '앱 데이터를 먼저 불러와 주세요.');
    if (epoch !== this.sessionEpoch || this.currentUserId() !== operation.userId) {
      throw new OfflineQueueRepositoryError('SESSION_CHANGED', '로그인 사용자가 바뀌었어요.');
    }

    const execute = async (repository: AppRepository): Promise<void> => {
      if (operation.serverApplied) {
        await cleanupAppliedExpensePhoto(repository, operation);
        return;
      }
      if (operation.kind === 'ADD_EXPENSE') {
        const expense = await repository.addExpense(operation.input);
        upsertExpense(snapshot.expenses, { ...expense, syncStatus: 'SYNCED' });
        addProcessedRequest(snapshot, operation.requestId);
      } else if (operation.kind === 'UPDATE_EXPENSE') {
        const expense = await repository.updateExpense(operation.targetId, operation.patch, {
          expectedPhotoPath: expectedUpdatePhotoPath(operation),
        });
        upsertExpense(snapshot.expenses, { ...expense, syncStatus: 'SYNCED' });
        const cleanupPath = replacedExpensePhotoPath(operation, expense);
        if (cleanupPath) {
          operation.serverApplied = true;
          operation.cleanupPhotoPath = cleanupPath;
          await cleanupAppliedExpensePhoto(repository, operation);
        }
      } else if (operation.kind === 'DELETE_EXPENSE') {
        await repository.deleteExpense(operation.targetId);
        operation.serverApplied = true;
        operation.cleanupPhotoPath = operation.baseEntity.photoPath;
        await cleanupAppliedExpensePhoto(repository, operation);
        const current = snapshot.expenses.find((expense) => expense.id === operation.targetId);
        if (current) {
          current.deletedAt = new Date(this.now()).toISOString();
          current.updatedAt = current.deletedAt;
          current.syncStatus = 'SYNCED';
          current.version = (current.version ?? operation.baseVersion ?? 0) + 1;
        }
      } else if (operation.kind === 'ADD_COMMENT') {
        const comment = await repository.addComment(operation.input);
        upsertComment(snapshot.comments, { ...comment, syncStatus: 'SYNCED' });
        addProcessedRequest(snapshot, operation.requestId);
      } else if (operation.kind === 'UPDATE_COMMENT') {
        const comment = await repository.updateComment(operation.targetId, operation.body);
        upsertComment(snapshot.comments, { ...comment, syncStatus: 'SYNCED' });
      } else if (operation.kind === 'DELETE_COMMENT') {
        await repository.deleteComment(operation.targetId);
        const current = snapshot.comments.find((comment) => comment.id === operation.targetId);
        if (current) {
          current.deletedAt = new Date(this.now()).toISOString();
          current.body = '삭제된 메시지입니다.';
          current.updatedAt = current.deletedAt;
          current.syncStatus = 'SYNCED';
          current.version = (current.version ?? operation.baseVersion ?? 0) + 1;
        }
      }
    };

    if (isSessionBoundRepository(this.base)) {
      await this.base.runAsUser(operation.userId, execute);
    } else {
      if (epoch !== this.sessionEpoch || this.currentUserId() !== operation.userId) {
        throw new OfflineQueueRepositoryError('SESSION_CHANGED', '로그인 사용자가 바뀌었어요.');
      }
      await execute(this.base);
    }
  }

  private scheduleRetryLocked(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.disposed) return;
    const userId = this.baseSnapshot?.currentUserId;
    if (!userId) return;
    const next = this.queue.operations
      .filter((operation) => operation.userId === userId && (
        operation.status === 'PENDING' || (
          isExpenseOperation(operation) && operation.failure?.code !== 'CUTOFF_EXPIRED'
        )
      ))
      .flatMap((operation) => [
        operation.status === 'PENDING' ? operation.nextAttemptAt : undefined,
        operation.serverApplied ? undefined : operation.deadlineAt,
      ])
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (next === undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.startFlush(false).catch(() => undefined);
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, next - this.now())));
  }

  private async persistLocked(): Promise<void> {
    this.queue.operations.sort(compareOperations);
    // Serialize once for both durable storage and the rollback checkpoint.
    // The previous implementation serialized the full queue twice per change.
    const serializedQueue = JSON.stringify(this.queue);
    const nextPersistedQueue = JSON.parse(serializedQueue) as QueueEnvelope;
    try {
      await this.storage.setItem(this.storageKey, serializedQueue);
    } catch (error) {
      this.queue = clone(this.persistedQueue);
      const rollbackRemovals = [...this.photoRemovalsAfterRollback];
      this.photoRemovalsAfterCommit.clear();
      this.photoRemovalsAfterRollback.clear();
      for (const uri of rollbackRemovals) await safelyRemove(this.photoStore, uri);
      throw error;
    }
    this.persistedQueue = nextPersistedQueue;
    this.queueRevision += 1;
    const committedRemovals = [...this.photoRemovalsAfterCommit];
    this.photoRemovalsAfterCommit.clear();
    this.photoRemovalsAfterRollback.clear();
    for (const uri of committedRemovals) await safelyRemove(this.photoStore, uri);
  }

  private emitLocked(): void {
    if (this.disposed || !this.baseSnapshot) return;
    const snapshot = this.composeLocked();
    this.listeners.forEach((listener) => listener(clone(snapshot)));
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class OfflineQueueRepositoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'OfflineQueueRepositoryError';
  }
}

class ExpoDocumentPhotoStore implements DurablePhotoStore {
  async persist(sourceUri: string, operationId: string): Promise<PersistedPhoto> {
    if (!/^(?:file|content):/u.test(sourceUri)) return { uri: sourceUri, owned: false };
    try {
      const { Directory, File, Paths } = await import('expo-file-system');
      const directory = new Directory(Paths.document, 'offline-expense-photos');
      directory.create({ idempotent: true, intermediates: true });
      const extension = photoExtension(sourceUri);
      const destination = new File(directory, `${safeFileStem(operationId)}.${extension}`);
      const source = new File(sourceUri);
      await source.copy(destination, { overwrite: true });
      return { uri: destination.uri, owned: true };
    } catch (error) {
      throw new OfflineQueueRepositoryError(
        'PHOTO_CACHE_FAILED',
        '오프라인 저장을 위해 사진을 안전한 앱 문서 폴더에 복사하지 못했어요.',
        { cause: error },
      );
    }
  }

  async remove(uri: string): Promise<void> {
    if (!uri.startsWith('file:')) return;
    const { File } = await import('expo-file-system');
    const file = new File(uri);
    if (file.exists) file.delete();
  }
}

function createNetInfoMonitor(): OfflineNetworkMonitor {
  return {
    async fetch() {
      return isOnline(await NetInfo.fetch());
    },
    subscribe(listener) {
      return NetInfo.addEventListener((state) => listener(isOnline(state)));
    },
  };
}

function isOnline(state: NetInfoState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const next = clone(snapshot);
  next.expenses = dedupeVersioned(next.expenses);
  next.comments = dedupeVersioned(next.comments);
  next.processedRequestIds = [...new Set(next.processedRequestIds)].sort();
  return next;
}

function sanitizeCachedSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const next = normalizeSnapshot(snapshot);
  next.profiles = next.profiles.map((profile) => {
    const sanitized = { ...profile };
    delete sanitized.avatarUri;
    return sanitized;
  });
  next.expenses = next.expenses.map((expense) => {
    const sanitized = { ...expense };
    delete sanitized.photoUri;
    return sanitized;
  });
  return next;
}

function canUseCachedSnapshot(error: unknown): boolean {
  const record = isRecord(error) ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof record?.code === 'string'
    ? record.code
    : /^([A-Z0-9_]+):/u.exec(message)?.[1];
  const status = Number(record?.status ?? record?.statusCode);
  if (status === 401 || status === 403) return false;
  if (['NETWORK_ERROR', 'TIMEOUT', 'ECONNRESET', 'ETIMEDOUT'].includes(code ?? '')) return true;
  return /network|failed to fetch|offline|timeout|timed out|connection|연결/u.test(
    message.toLowerCase(),
  );
}

function dedupeVersioned<T extends { id: string; clientRequestId: string; userId: string; createdAt: string; updatedAt: string; version?: number; syncStatus: string }>(
  values: T[],
): T[] {
  const parent = values.map((_, index) => index);
  const identityOwner = new Map<string, number>();
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  values.forEach((value, index) => {
    const identities = [
      `id:${value.id}`,
      ...(value.clientRequestId ? [`request:${value.userId}:${value.clientRequestId}`] : []),
    ];
    for (const identity of identities) {
      const owner = identityOwner.get(identity);
      if (owner === undefined) identityOwner.set(identity, index);
      else union(index, owner);
    }
  });
  const groups = new Map<number, T>();
  values.forEach((value, index) => {
    const root = find(index);
    const existing = groups.get(root);
    groups.set(root, existing ? preferVersioned(existing, value) : value);
  });
  return [...groups.values()].sort((left, right) => {
    const time = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return Number.isNaN(time) || time === 0 ? left.id.localeCompare(right.id) : time;
  });
}

function preferVersioned<T extends { id: string; updatedAt: string; version?: number; syncStatus: string }>(left: T, right: T): T {
  const versionDelta = (right.version ?? 0) - (left.version ?? 0);
  if (versionDelta !== 0) return versionDelta > 0 ? right : left;
  const timeDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta > 0 ? right : left;
  if (left.syncStatus !== right.syncStatus) return right.syncStatus === 'SYNCED' ? right : left;
  return right.id.localeCompare(left.id) < 0 ? right : left;
}

function upsertExpense(expenses: Expense[], next: Expense): void {
  const index = expenses.findIndex(
    (expense) => expense.id === next.id || (
      expense.userId === next.userId && expense.clientRequestId === next.clientRequestId
    ),
  );
  if (index < 0) expenses.unshift(next);
  else expenses[index] = preferVersioned(expenses[index], next);
}

function replaceExpenseProjection(expenses: Expense[], next: Expense): void {
  const index = expenses.findIndex(
    (expense) => expense.id === next.id || (
      expense.userId === next.userId && expense.clientRequestId === next.clientRequestId
    ),
  );
  if (index < 0) expenses.unshift(next);
  else expenses[index] = next;
}

function upsertComment(comments: Comment[], next: Comment): void {
  const index = comments.findIndex(
    (comment) => comment.id === next.id || (
      comment.userId === next.userId && comment.clientRequestId === next.clientRequestId
    ),
  );
  if (index < 0) comments.push(next);
  else comments[index] = preferVersioned(comments[index], next);
}

function addProcessedRequest(snapshot: AppSnapshot, requestId: string): void {
  if (!snapshot.processedRequestIds.includes(requestId)) snapshot.processedRequestIds.push(requestId);
}

function expensePatchMatches(
  expense: Expense,
  patch: Partial<AddExpenseInput>,
  expectedPhotoPath: string | undefined,
): boolean {
  return Object.entries(patch).every(([key, value]) => {
    if (key === 'photoUri') {
      if (value === undefined) return true;
      if (!value) return !expense.photoPath;
      return Boolean(expectedPhotoPath) && expense.photoPath === expectedPhotoPath;
    }
    return Object.is(expense[key as keyof Expense], value);
  });
}

function replacedExpensePhotoPath(
  operation: UpdateExpenseOperation,
  remote: Expense,
): string | undefined {
  const expectedPhotoPath = expectedUpdatePhotoPath(operation);
  const photoWasReplaced = operation.patch.photoUri
    ? remote.photoPath === expectedPhotoPath
    : operation.patch.photoUri === '' && !remote.photoPath;
  return photoWasReplaced &&
    operation.baseEntity.photoPath &&
    remote.photoPath !== operation.baseEntity.photoPath
    ? operation.baseEntity.photoPath
    : undefined;
}

function expectedUpdatePhotoPath(operation: UpdateExpenseOperation): string | undefined {
  if (!operation.patch.photoUri) return undefined;
  const folder = operation.baseEntity.periodId ?? 'personal';
  const revision = operation.photoRevision ?? 1;
  return `${folder}/${operation.userId}/${safeFileStem(operation.id)}-photo-${revision}`;
}

async function cleanupAppliedExpensePhoto(
  repository: AppRepository,
  operation: MutationOperation,
): Promise<void> {
  if (!operation.cleanupPhotoPath) return;
  if (!supportsExpensePhotoCleanup(repository)) {
    throw new OfflineQueueRepositoryError(
      'PHOTO_CLEANUP_UNSUPPORTED',
      '서버에 남은 이전 사진을 안전하게 정리할 수 없어요.',
    );
  }
  await repository.cleanupExpensePhoto(operation.cleanupPhotoPath);
}

function hasAdvancedVersion(
  remote: { version?: number } | undefined,
  baseVersion: number | undefined,
): boolean {
  return remote?.version !== undefined && baseVersion !== undefined && remote.version > baseVersion;
}

function applyPhotoUri(operation: MutationOperation, uri: string): void {
  if (operation.kind === 'ADD_EXPENSE') operation.input.photoUri = uri;
  if (operation.kind === 'UPDATE_EXPENSE') operation.patch.photoUri = uri;
}

/**
 * 서버가 이 사용자의 방 쓰기를 막고 있는가. 표시는 멤버십 행에 있으므로 스냅샷만
 * 보면 되고, 앱을 다시 켜도 같은 답이 나온다.
 */
function isNicknameChangeRequired(snapshot: AppSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.roomMembers.some(
    (member) =>
      member.userId === snapshot.currentUserId
      && member.status === 'ACTIVE'
      && member.nicknameChangeRequired,
  );
}

function classifyError(error: unknown): { code: string; message: string; permanent: boolean } {
  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const codeFromMessage = /^([A-Z0-9_]+):/u.exec(rawMessage)?.[1];
  const code = typeof record?.code === 'string' ? record.code : codeFromMessage ?? 'UNKNOWN_ERROR';
  const normalized = rawMessage.toLowerCase();
  const status = Number(record?.status ?? record?.statusCode);
  const transient =
    ['NETWORK_ERROR', 'TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'SUPABASE_ERROR'].includes(code) ||
    [408, 425, 429, 500, 502, 503, 504].includes(status) ||
    /network|failed to fetch|offline|timeout|timed out|connection|연결/u.test(normalized);
  const permanentCodes = new Set([
    'AUTH_REQUIRED',
    'VERSION_CONFLICT',
    'FORBIDDEN',
    'NOT_FOUND',
    'IMMUTABLE_FIELD',
    'REQUEST_ID_REQUIRED',
    'PHOTO_TYPE_NOT_ALLOWED',
    'PHOTO_READ_FAILED',
    'PHOTO_CACHE_FAILED',
    'PHOTO_CLEANUP_UNSUPPORTED',
    '40001',
    '42501',
    'P0001',
  ]);
  const policyMessage = /마감|잠긴|읽기 전용|권한|공휴일|합류 전|내 지출|내 댓글|5분|정책|기간 안|photo.*required/u.test(normalized);
  const postgresPolicyCode = /^(?:22|23)[0-9A-Z]{3}$/u.test(code);
  return {
    code,
    message: rawMessage.replace(/^[A-Z0-9_]+:\s*/u, '') || '작업을 동기화하지 못했어요.',
    permanent: !transient && (permanentCodes.has(code) || policyMessage || postgresPolicyCode),
  };
}

function failureFor(
  operation: MutationOperation,
  code: string,
  message: string,
  now: number,
  permanent: boolean,
): OfflineMutationFailure {
  const occurredAt = new Date(now).toISOString();
  return {
    code,
    message,
    occurredAt,
    permanent,
    copyableMessage: [
      `오프라인 작업 ID: ${operation.id}`,
      `요청 ID: ${operation.requestId}`,
      `오류 코드: ${code}`,
      `시각: ${occurredAt}`,
      message,
    ].join('\n'),
  };
}

function toSummary(operation: MutationOperation): OfflineMutationSummary {
  return {
    operationId: operation.id,
    requestId: operation.requestId,
    kind: operation.kind,
    entityId: operationEntityId(operation),
    status: operation.status,
    attempts: operation.attempts,
    enqueuedAt: operation.enqueuedAt,
    nextAttemptAt: operation.nextAttemptAt,
    failure: operation.failure ? clone(operation.failure) : undefined,
  };
}

function operationEntityId(operation: MutationOperation): string {
  if (operation.kind === 'ADD_EXPENSE' || operation.kind === 'ADD_COMMENT') {
    return operation.optimisticId;
  }
  return operation.targetId;
}

function isExpenseOperation(
  operation: MutationOperation,
): operation is AddExpenseOperation | UpdateExpenseOperation | DeleteExpenseOperation {
  return operation.kind === 'ADD_EXPENSE' ||
    operation.kind === 'UPDATE_EXPENSE' ||
    operation.kind === 'DELETE_EXPENSE';
}

function expensePeriodId(
  operation: AddExpenseOperation | UpdateExpenseOperation | DeleteExpenseOperation,
): string | undefined {
  return operation.kind === 'ADD_EXPENSE'
    ? operation.input.periodId
    : operation.baseEntity.periodId;
}

function isExpired(deadlineAt: string | undefined, now: number): boolean {
  if (!deadlineAt) return false;
  const deadline = Date.parse(deadlineAt);
  return Number.isFinite(deadline) && now >= deadline;
}

function compareOperations(left: MutationOperation, right: MutationOperation): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function requireExpenseById(snapshot: AppSnapshot, id: string): Expense {
  const expense = snapshot.expenses.find((item) => item.id === id);
  if (!expense) throw new OfflineQueueRepositoryError('NOT_FOUND', '지출 기록을 찾을 수 없어요.');
  return clone(expense);
}

function requireCommentById(snapshot: AppSnapshot, id: string): Comment {
  const comment = snapshot.comments.find((item) => item.id === id);
  if (!comment) throw new OfflineQueueRepositoryError('NOT_FOUND', '댓글을 찾을 수 없어요.');
  return clone(comment);
}

function isQueueEnvelope(value: unknown): value is QueueEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 &&
    Number.isInteger(record.nextSequence) &&
    Number(record.nextSequence) >= 1 &&
    Array.isArray(record.operations) &&
    record.operations.every(isMutationOperation);
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.snapshots)) return false;
  return Object.entries(value.snapshots).every(([userId, snapshot]) =>
    isAppSnapshot(snapshot) && snapshot.currentUserId === userId,
  );
}

function isAppSnapshot(value: unknown): value is AppSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.currentUserId === 'string' && value.currentUserId.length > 0 &&
    isRecordArray(value.profiles) &&
    isRecordArray(value.rooms) &&
    isRecordArray(value.roomMembers) &&
    isRecordArray(value.periods) &&
    isRecordArray(value.periodMembers) &&
    isRecordArray(value.periodResults) &&
    isRecordArray(value.memberStats) &&
    isRecordArray(value.expenses) &&
    isRecordArray(value.comments) &&
    Array.isArray(value.processedRequestIds) &&
    value.processedRequestIds.every((requestId) => typeof requestId === 'string');
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isMutationOperation(value: unknown): value is MutationOperation {
  if (value === null || typeof value !== 'object') return false;
  const operation = value as Record<string, unknown>;
  const kind = operation.kind;
  const validBase =
    typeof operation.id === 'string' && operation.id.length > 0 &&
    typeof operation.requestId === 'string' && operation.requestId.length > 0 &&
    typeof operation.userId === 'string' && operation.userId.length > 0 &&
    (operation.status === 'PENDING' || operation.status === 'FAILED') &&
    Number.isInteger(operation.sequence) && Number(operation.sequence) >= 1 &&
    Number.isInteger(operation.attempts) && Number(operation.attempts) >= 0 &&
    typeof operation.enqueuedAt === 'string' &&
    typeof operation.updatedAt === 'string' &&
    (operation.deadlineAt === undefined || typeof operation.deadlineAt === 'string') &&
    (operation.serverApplied === undefined || typeof operation.serverApplied === 'boolean') &&
    (operation.cleanupPhotoPath === undefined || typeof operation.cleanupPhotoPath === 'string') &&
    (operation.photoRevision === undefined || (
      Number.isInteger(operation.photoRevision) && Number(operation.photoRevision) >= 1
    ));
  if (!validBase) return false;
  if (kind === 'ADD_EXPENSE' || kind === 'ADD_COMMENT') {
    return typeof operation.optimisticId === 'string' && isRecord(operation.input);
  }
  if (kind === 'UPDATE_EXPENSE') {
    return typeof operation.targetId === 'string' && isRecord(operation.patch) && isRecord(operation.baseEntity);
  }
  if (kind === 'UPDATE_COMMENT') {
    return typeof operation.targetId === 'string' && typeof operation.body === 'string' && isRecord(operation.baseEntity);
  }
  if (kind === 'DELETE_EXPENSE' || kind === 'DELETE_COMMENT') {
    return typeof operation.targetId === 'string' && isRecord(operation.baseEntity);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function photoExtension(uri: string): string {
  const extension = /\.([a-z0-9]{2,5})(?:[?#]|$)/iu.exec(uri)?.[1]?.toLowerCase();
  return extension && ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(extension) ? extension : 'jpg';
}

function safeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 120);
}

async function safelyRemove(photoStore: DurablePhotoStore, uri: string): Promise<void> {
  try {
    await photoStore.remove(uri);
  } catch {
    // A stale cache file is preferable to losing the queued mutation.
  }
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function makeUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const seed = `${Date.now()}:${Math.random()}:${Math.random()}`;
  const parts = [0, 1, 2, 3].map((index) => hash32(`${index}:${seed}`).toString(16).padStart(8, '0')).join('');
  return `${parts.slice(0, 8)}-${parts.slice(8, 12)}-4${parts.slice(13, 16)}-a${parts.slice(17, 20)}-${parts.slice(20, 32)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
