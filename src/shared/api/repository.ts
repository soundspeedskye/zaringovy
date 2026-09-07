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
  UpdateRoomPostInput,
  ExpenseExceptionResponseDecision,
  SwitchRoomInput,
  UpdateRoomSettingsInput,
} from '@/shared/api/types';

export type Unsubscribe = () => void;

export type UpdateExpenseOptions = {
  /** Deterministic Storage path used to recognize a response-lost photo update. */
  expectedPhotoPath?: string;
};

export interface AppRepository {
  load(): Promise<AppSnapshot>;
  updateNickname(nickname: string): Promise<Profile>;
  updateAvatar(input: { avatarKey?: string; photoUri?: string | null }): Promise<Profile>;
  createRoom(input: CreateRoomInput): Promise<Room>;
  updateRoomSettings(input: UpdateRoomSettingsInput): Promise<Room>;
  previewInvite(inviteCode: string): Promise<InvitePreview>;
  joinRoom(inviteCode: string, joinedAt?: string): Promise<RoomMember>;
  leaveRoom(roomId: string, successorId?: string): Promise<void>;
  closeRoom(roomId: string): Promise<void>;
  switchRoom(input: SwitchRoomInput): Promise<RoomMember>;
  addExpense(input: AddExpenseInput): Promise<Expense>;
  respondToExpenseException(
    expenseId: string,
    decision: ExpenseExceptionResponseDecision,
  ): Promise<void>;
  withdrawExpenseException(expenseId: string): Promise<void>;
  updateExpense(
    expenseId: string,
    patch: Partial<AddExpenseInput>,
    options?: UpdateExpenseOptions,
  ): Promise<Expense>;
  deleteExpense(expenseId: string): Promise<void>;
  deleteArchivedPeriod(periodId: string): Promise<void>;
  addComment(input: AddCommentInput): Promise<Comment>;
  updateComment(commentId: string, body: string): Promise<Comment>;
  deleteComment(commentId: string): Promise<void>;
  toggleCommentReaction(commentId: string, emoji: CommentReactionEmoji): Promise<void>;
  markExpenseRead(expenseId: string): Promise<void>;
  addRoomPost(input: AddRoomPostInput): Promise<RoomPost>;
  updateRoomPost(input: UpdateRoomPostInput): Promise<RoomPost>;
  deleteRoomPost(postId: string): Promise<void>;
  addRoomPostComment(input: AddRoomPostCommentInput): Promise<RoomPostComment>;
  updateRoomPostComment(commentId: string, body: string): Promise<RoomPostComment>;
  deleteRoomPostComment(commentId: string): Promise<void>;
  toggleRoomPostReaction(postId: string, emoji: RoomPostReactionEmoji): Promise<void>;
  markRoomPostRead(postId: string): Promise<void>;
  voteRoomPostPoll(postId: string, optionId: string): Promise<void>;
  markNotificationsRead(notificationIds: readonly string[]): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
  sendWinnerNudge(input: { roomId: string; body: string }): Promise<void>;
  subscribe(listener: (snapshot: AppSnapshot) => void): Unsubscribe;
}

export interface SessionBoundRepository extends AppRepository {
  runAsUser<T>(
    userId: string,
    work: (repository: AppRepository) => Promise<T>,
  ): Promise<T>;
}

export interface ExpensePhotoCleanupRepository extends AppRepository {
  cleanupExpensePhoto(path: string): Promise<void>;
}

export function isSessionBoundRepository(
  repository: AppRepository,
): repository is SessionBoundRepository {
  return 'runAsUser' in repository && typeof repository.runAsUser === 'function';
}

export function supportsExpensePhotoCleanup(
  repository: AppRepository,
): repository is ExpensePhotoCleanupRepository {
  return 'cleanupExpensePhoto' in repository && typeof repository.cleanupExpensePhoto === 'function';
}
