import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import type {
  AppRepository,
  Unsubscribe,
  UpdateExpenseOptions,
} from "@/shared/api/repository";
import { createSupabaseClientForAccessToken } from "@/shared/api/supabase-client";
import type {
  AddCommentInput,
  AddExpenseInput,
  AddRoomPostCommentInput,
  AddRoomPostInput,
  AppSnapshot,
  Comment,
  CommentReactionEmoji,
  CreateRoomInput,
  Expense,
  ExpenseExceptionResponseDecision,
  InvitePreview,
  Profile,
  Room,
  RoomMember,
  RoomPost,
  RoomPostCategory,
  RoomPostComment,
  RoomPostReactionEmoji,
  SwitchRoomInput,
  UpdateRoomSettingsInput,
  UpdateRoomPostInput,
} from "@/shared/api/types";
import {
  RepositoryError,
  inviteError,
  isAlreadyExistsError,
  switchRoomError,
  translateError,
} from "./supabase/errors";
import {
  requireComment,
  requireExpense,
  requireProfile,
  requireRoom,
  requireRoomPost,
  requireRoomPostComment,
  requireVersion,
} from "./supabase/guards";
import { asObject, firstObject, isString } from "./supabase/json";
import {
  expenseThumbnailPath,
  hash32,
  mapComment,
  mapCommentMention,
  mapCommentReaction,
  mapExpense,
  mapExpenseException,
  mapExpenseExceptionResponse,
  mapInvitePreview,
  mapNotification,
  mapPeriod,
  mapPeriodMember,
  mapPeriodResult,
  mapExpenseRead,
  mapProfile,
  mapRoom,
  mapRoomMember,
  mapRoomPost,
  mapRoomPostComment,
  mapRoomPostPollOption,
  mapRoomPostPollVote,
  mapRoomPostReaction,
  mapRoomPostRead,
  mapStats,
  mapWinnerNudgeGrant,
  requiredString,
} from "./supabase/mappers";
import { readPhoto, safeObjectStem } from "./supabase/photos";
import {
  fetchCommentReactionRows,
  fetchCommentMentionRows,
  fetchCommentRows,
  fetchExceptionResponseRows,
  fetchExceptionRows,
  fetchExpenseReadRows,
  fetchExpenseRows,
  fetchNotificationRows,
  fetchWinnerNudgeGrantRows,
  fetchRoomPostCommentRows,
  fetchRoomPostPollOptionRows,
  fetchRoomPostPollVoteRows,
  fetchRoomPostReactionRows,
  fetchRoomPostReadRows,
  fetchRoomPostRows,
} from "./supabase/queries";
import {
  clone,
  collectProcessedRequestIds,
  filterVisibleCommentRows,
  filterVisibleExpenseRows,
  groupBy,
  makeUuid,
  rows,
  toRequestUuid,
} from "./supabase/results";
import type {
  InviteCodeRow,
  PeriodDayRow,
  PeriodMemberRow,
  PeriodResultRow,
  PeriodStatusRow,
  PreferenceRow,
  ProfileRow,
  RoomMemberRow,
  RoomMemberStatsRow,
  RoomRow,
  WinnerNudgeGrantRow,
} from "./supabase/rows";
import { CATEGORY_TO_DATABASE } from "./supabase/rows";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const SIGNED_URL_REFRESH_MS = 50 * 60 * 1_000;
const MAX_EXPENSE_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_ROOM_POST_PHOTO_BYTES = 10 * 1024 * 1024;
const ROOM_POST_CATEGORY_TO_DATABASE: Record<
  RoomPostCategory,
  "frugality" | "secret_purchase" | "chat"
> = {
  "거지력": "frugality",
  "뒷구매": "secret_purchase",
  "잡담": "chat",
};
const REALTIME_TABLES = [
  "profiles",
  "rooms",
  "room_members",
  "periods",
  "period_members",
  "period_results",
  "expenses",
  "expense_reads",
  "comments",
  "comment_mentions",
  "comment_reactions",
  "room_posts",
  "room_post_comments",
  "room_post_reactions",
  "room_post_reads",
  "room_post_poll_options",
  "room_post_poll_votes",
  "notifications",
  "winner_nudge_grants",
  "expense_exceptions",
  "expense_exception_approvals",
] as const;
type RealtimeTable = (typeof REALTIME_TABLES)[number];

type SupabaseRepositoryOptions = {
  fixedUserId?: string;
  observeAuth?: boolean;
};

type ReloadJob = {
  isFullReloadInFlight: boolean;
  needsFullReload: boolean;
  promise: Promise<AppSnapshot>;
  tables: Set<RealtimeTable>;
  /** null이면 전체 멘션 재조회, 값이 있으면 해당 댓글만 재조회한다. */
  commentMentionIds: Set<string> | null;
};

function mergeReloadRequest(
  job: ReloadJob,
  tables: ReadonlySet<RealtimeTable> | undefined,
  commentMentionIds?: ReadonlySet<string>,
): void {
  if (tables === undefined) {
    if (job.needsFullReload || job.isFullReloadInFlight) return;
    job.needsFullReload = true;
    job.tables.clear();
    job.commentMentionIds = null;
    return;
  }
  if (job.needsFullReload) return;
  tables.forEach((table) => job.tables.add(table));
  if (tables.has("comment_mentions")) {
    if (!commentMentionIds) job.commentMentionIds = null;
    else if (job.commentMentionIds) {
      commentMentionIds.forEach((commentId) => job.commentMentionIds?.add(commentId));
    }
  }
}

export class SupabaseRepository implements AppRepository {
  private readonly listeners = new Set<(snapshot: AppSnapshot) => void>();
  private lastSnapshot: AppSnapshot | null = null;
  private loading: Promise<AppSnapshot> | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private realtimeUserId: string | null = null;
  private realtimeReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly realtimeDirtyTables = new Set<RealtimeTable>();
  private readonly realtimeDirtyMentionCommentIds = new Set<string>();
  /**
   * comment_mentions 이벤트가 comment_id를 싣지 않고 왔다는 표시.
   * DELETE는 REPLICA IDENTITY에 따라 기본키만 실려 오므로 어느 댓글의 멘션이
   * 바뀌었는지 알 수 없다. 그때는 멘션 전체를 다시 읽는다.
   */
  private realtimeNeedsAllMentionIds = false;
  private realtimeNeedsFullReload = false;
  private signedUrlRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadJob: ReloadJob | null = null;
  private authUserId: string | null | undefined;
  private authGeneration = 0;

  private readonly fixedUserId?: string;

  constructor(
    private readonly client: SupabaseClient,
    options: SupabaseRepositoryOptions = {},
  ) {
    this.fixedUserId = options.fixedUserId;
    if (this.fixedUserId) this.authUserId = this.fixedUserId;
    if (options.observeAuth === false) return;
    this.client.auth.onAuthStateChange((event, session) => {
      const nextUserId = session?.user.id ?? null;
      const userChanged =
        this.authUserId !== undefined && this.authUserId !== nextUserId;
      this.authUserId = nextUserId;
      if (!session || userChanged) {
        this.authGeneration += 1;
        this.lastSnapshot = null;
        this.loading = null;
        this.reloadJob = null;
        void this.teardownRealtime();
      } else if (event === "SIGNED_IN" && this.listeners.size > 0) {
        this.scheduleRealtimeReload();
      }
    });
  }

  async runAsUser<T>(
    userId: string,
    work: (repository: AppRepository) => Promise<T>,
  ): Promise<T> {
    if (this.fixedUserId) {
      if (this.fixedUserId !== userId) {
        throw new RepositoryError(
          "SESSION_CHANGED",
          "로그인 사용자가 바뀌었어요.",
        );
      }
      return work(this);
    }
    const { data, error } = await this.client.auth.getSession();
    if (error) throw translateError(error, "로그인 상태를 확인하지 못했어요.");
    if (!data.session || data.session.user.id !== userId) {
      throw new RepositoryError(
        "SESSION_CHANGED",
        "로그인 사용자가 바뀌었어요.",
      );
    }
    const scoped = new SupabaseRepository(
      createSupabaseClientForAccessToken(data.session.access_token),
      { fixedUserId: userId, observeAuth: false },
    );
    return work(scoped);
  }

  async cleanupExpensePhoto(path: string): Promise<void> {
    const { error } = await this.client.storage
      .from("expense-photos")
      .remove([path, expenseThumbnailPath(path)]);
    if (error)
      throw translateError(error, "교체 또는 삭제된 사진을 정리하지 못했어요.");
  }

  async load(): Promise<AppSnapshot> {
    // A realtime or mutation refresh already in progress is newer than a
    // standalone load. Joining it prevents a slower load from committing stale
    // data after the refresh has completed.
    if (this.reloadJob) {
      mergeReloadRequest(this.reloadJob, undefined);
      return clone(await this.reloadJob.promise);
    }
    if (!this.loading) {
      const generation = this.authGeneration;
      const request = this.fetchSnapshot().then((snapshot) => {
        this.assertCurrentAuthSnapshot(snapshot, generation);
        this.lastSnapshot = snapshot;
        return snapshot;
      });
      this.loading = request;
      void request.then(
        () => {
          if (this.loading === request) this.loading = null;
        },
        () => {
          if (this.loading === request) this.loading = null;
        },
      );
    }
    return clone(await this.loading);
  }

  async updateNickname(nickname: string): Promise<Profile> {
    await this.requireUserId();
    const { error } = await this.client.rpc("update_my_nickname", {
      p_nickname: nickname.trim(),
    });
    if (error) throw translateError(error, "닉네임을 변경하지 못했어요.");
    const snapshot = await this.reloadAndNotify();
    return clone(requireProfile(snapshot, snapshot.currentUserId));
  }

  async updateAvatar(input: {
    avatarKey?: string;
    photoUri?: string | null;
  }): Promise<Profile> {
    const userId = await this.requireUserId();
    const snapshot = this.lastSnapshot ?? (await this.load());
    const current = requireProfile(snapshot, userId);
    const avatarKey = input.avatarKey ?? current.avatarKey ?? current.avatar;
    let avatarPath = current.avatarPath ?? null;
    let uploadedPath: string | null = null;
    if (input.photoUri !== undefined) {
      if (input.photoUri) {
        uploadedPath = await this.uploadProfilePhoto(input.photoUri, userId);
        avatarPath = uploadedPath;
      } else {
        avatarPath = null;
      }
    }
    const { error } = await this.client.rpc("update_my_avatar", {
      p_avatar_key: avatarKey,
      p_avatar_path: avatarPath,
    });
    if (error) {
      if (uploadedPath) await this.removeOrphanProfilePhoto(uploadedPath);
      throw translateError(error, "프로필 사진을 변경하지 못했어요.");
    }
    if (current.avatarPath && current.avatarPath !== avatarPath) {
      await this.removeOrphanProfilePhoto(current.avatarPath);
    }
    const next = await this.reloadAndNotify();
    return clone(requireProfile(next, userId));
  }

  async createRoom(input: CreateRoomInput): Promise<Room> {
    await this.requireUserId();
    const requestId = toRequestUuid(input.clientRequestId ?? makeUuid());
    const { data, error } = await this.client.rpc("create_room", {
      p_name: input.name.trim(),
      p_base_amount: input.baseAmount,
      p_capacity: input.capacity,
      p_client_request_id: requestId,
    });
    if (error) throw translateError(error, "방을 만들지 못했어요.");

    const payload = firstObject(data);
    const roomPayload = asObject(payload?.room);
    const id = requiredString(roomPayload?.id, "생성된 방 ID");
    const snapshot = await this.reloadAndNotify();
    return clone(requireRoom(snapshot, id));
  }

  async updateRoomSettings(input: UpdateRoomSettingsInput): Promise<Room> {
    await this.requireUserId();
    const { error } = await this.client.rpc("update_room_settings", {
      p_room_id: input.roomId,
      p_name: input.name.trim(),
      p_capacity: input.capacity,
    });
    if (error) throw translateError(error, "방 설정을 저장하지 못했어요.");
    const snapshot = await this.reloadAndNotify();
    return clone(requireRoom(snapshot, input.roomId));
  }

  async previewInvite(inviteCode: string): Promise<InvitePreview> {
    await this.requireUserId();
    const normalized = inviteCode.trim().toUpperCase();
    const { data, error } = await this.client.rpc("preview_room_invite", {
      p_invite_code: normalized,
    });
    if (error) throw translateError(error, "참여 코드를 확인하지 못했어요.");

    const payload = firstObject(data);
    if (!payload || payload.ok !== true) {
      throw inviteError(
        typeof payload?.error_code === "string"
          ? payload.error_code
          : "INVALID_CODE",
      );
    }
    return mapInvitePreview(normalized, payload);
  }

  async joinRoom(inviteCode: string): Promise<RoomMember> {
    await this.requireUserId();
    const normalized = inviteCode.trim().toUpperCase();
    const { data, error } = await this.client.rpc("join_room", {
      p_invite_code: normalized,
    });
    if (error) throw translateError(error, "방에 참여하지 못했어요.");

    const payload = firstObject(data);
    if (!payload || payload.ok !== true) {
      throw inviteError(
        typeof payload?.error_code === "string"
          ? payload.error_code
          : "INVALID_CODE",
      );
    }
    const memberPayload = asObject(payload.member);
    const roomId = requiredString(memberPayload?.room_id, "참여 방 ID");
    const userId = requiredString(memberPayload?.user_id, "참여 사용자 ID");
    const snapshot = await this.reloadAndNotify();
    const member = snapshot.roomMembers.find(
      (item) => item.roomId === roomId && item.userId === userId,
    );
    if (!member)
      throw new RepositoryError(
        "INVALID_RESPONSE",
        "참여 결과를 다시 불러오지 못했어요.",
      );
    return clone(member);
  }

  async leaveRoom(roomId: string, successorId?: string): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("leave_room", {
      p_room_id: roomId,
      p_successor_user_id: successorId ?? null,
    });
    if (error) throw translateError(error, "방을 나가지 못했어요.");
    await this.reloadAndNotify();
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("close_room", {
      p_room_id: roomId,
    });
    if (error) throw translateError(error, "방을 닫지 못했어요.");
    await this.reloadAndNotify();
  }

  async switchRoom(input: SwitchRoomInput): Promise<RoomMember> {
    await this.requireUserId();
    const joinCode = input.joinCode.trim().toUpperCase();
    const { data, error } = await this.client.rpc("switch_room", {
      p_leave_room_id: input.leaveRoomId,
      p_successor_user_id: input.successorId ?? null,
      p_join_code: joinCode,
    });
    // The join half reports capacity/re-join failures by rolling the whole
    // switch back and raising, so the friendly reason arrives as an error.
    if (error) throw switchRoomError(error);

    const payload = firstObject(data);
    const joinPayload = asObject(payload?.join);
    const memberPayload = asObject(joinPayload?.member);
    const roomId = requiredString(memberPayload?.room_id, "참여 방 ID");
    const userId = requiredString(memberPayload?.user_id, "참여 사용자 ID");
    const snapshot = await this.reloadAndNotify();
    const member = snapshot.roomMembers.find(
      (item) => item.roomId === roomId && item.userId === userId,
    );
    if (!member)
      throw new RepositoryError(
        "INVALID_RESPONSE",
        "참여 결과를 다시 불러오지 못했어요.",
      );
    return clone(member);
  }

  async respondToExpenseException(
    expenseId: string,
    decision: ExpenseExceptionResponseDecision,
  ): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("respond_expense_exception", {
      p_expense_id: expenseId,
      p_decision: decision === "HELD" ? "held" : "approved",
    });
    if (error) throw translateError(error, "예외 응답을 저장하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["expense_exception_approvals"]),
    );
  }

  async withdrawExpenseException(expenseId: string): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("withdraw_expense_exception", {
      p_expense_id: expenseId,
    });
    if (error) throw translateError(error, "예외를 취소하지 못했어요.");
    // Withdrawing drops the exception row and cascades its approvals.
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>([
        "expense_exceptions",
        "expense_exception_approvals",
      ]),
    );
  }

  async addExpense(input: AddExpenseInput): Promise<Expense> {
    const userId = await this.requireUserId();
    const requestId = toRequestUuid(input.clientRequestId);
    const photoPath = input.photoUri
      ? await this.uploadExpensePhoto(
          input.photoUri,
          input.periodId,
          userId,
          requestId,
        )
      : null;
    const { data, error } = await this.client.rpc("add_expense", {
      p_period_id: input.periodId ?? null,
      p_amount: input.amount,
      p_point_amount: input.pointAmount,
      p_category: CATEGORY_TO_DATABASE[input.category],
      p_occurred_at: input.occurredAt,
      p_memo: input.memo || null,
      p_photo_path: photoPath,
      p_client_request_id: requestId,
      p_exception_reason: input.exceptionReason?.trim() || null,
    });
    if (error) {
      if (photoPath) await this.removeOrphanPhoto(photoPath);
      throw translateError(error, "지출을 저장하지 못했어요.");
    }

    const id = requiredString(firstObject(data)?.id, "생성된 지출 ID");
    // add_expense can also insert an exception row, so patch both tables.
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["expenses", "expense_exceptions"]),
    );
    return clone(requireExpense(snapshot, id));
  }

  async updateExpense(
    expenseId: string,
    patch: Partial<AddExpenseInput>,
    options?: UpdateExpenseOptions,
  ): Promise<Expense> {
    const userId = await this.requireUserId();
    const current = await this.findCurrentExpense(expenseId);
    if (patch.periodId !== undefined && patch.periodId !== current.periodId) {
      throw new RepositoryError(
        "IMMUTABLE_FIELD",
        "등록한 주차는 변경할 수 없어요.",
      );
    }
    if (
      patch.clientRequestId !== undefined &&
      patch.clientRequestId !== current.clientRequestId
    ) {
      throw new RepositoryError(
        "IMMUTABLE_FIELD",
        "요청 식별자는 변경할 수 없어요.",
      );
    }
    const expectedVersion = requireVersion(current.version, "지출");
    const next = { ...current, ...patch };
    let photoPath = current.photoPath ?? null;
    let uploadedNewPhoto = false;
    if (patch.photoUri !== undefined && patch.photoUri !== current.photoUri) {
      if (patch.photoUri) {
        photoPath = await this.uploadExpensePhoto(
          patch.photoUri,
          current.periodId,
          userId,
          `${expenseId}-v${expectedVersion + 1}-${hash32(patch.photoUri).toString(16)}`,
          options?.expectedPhotoPath,
        );
        uploadedNewPhoto = true;
      } else {
        photoPath = null;
      }
    }

    const { error } = await this.client.rpc("update_expense", {
      p_expense_id: expenseId,
      p_amount: next.amount,
      p_point_amount: next.pointAmount,
      p_category: CATEGORY_TO_DATABASE[next.category],
      p_occurred_at: next.occurredAt,
      p_memo: next.memo || null,
      p_photo_path: photoPath,
      p_expected_version: expectedVersion,
    });
    if (error) {
      if (uploadedNewPhoto && photoPath)
        await this.removeOrphanPhoto(photoPath);
      throw translateError(error, "지출을 수정하지 못했어요.");
    }

    if (
      uploadedNewPhoto &&
      current.photoPath &&
      current.photoPath !== photoPath
    ) {
      await this.removeOrphanPhoto(current.photoPath);
    }
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["expenses"]),
    );
    return clone(requireExpense(snapshot, expenseId));
  }

  async deleteExpense(expenseId: string): Promise<void> {
    await this.requireUserId();
    const current = await this.findCurrentExpense(expenseId);
    const { error } = await this.client.rpc("delete_expense", {
      p_expense_id: expenseId,
      p_expected_version: requireVersion(current.version, "지출"),
    });
    if (error) throw translateError(error, "지출을 삭제하지 못했어요.");
    if (current.photoPath) await this.removeOrphanPhoto(current.photoPath);
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["expenses"]),
    );
  }

  async deleteArchivedPeriod(periodId: string): Promise<void> {
    await this.requireUserId();
    const snapshot = this.lastSnapshot ?? (await this.load());
    const photoPaths = snapshot.expenses
      .filter((expense) => expense.periodId === periodId)
      .map((expense) => expense.photoPath)
      .filter((path): path is string => typeof path === "string")
      .flatMap((path) => [path, expenseThumbnailPath(path)]);
    const { error } = await this.client.rpc("delete_archived_period", {
      p_period_id: periodId,
    });
    if (error) throw translateError(error, "지난 주차를 삭제하지 못했어요.");
    if (photoPaths.length) {
      const { error: storageError } = await this.client.storage
        .from("expense-photos")
        .remove(photoPaths);
      if (storageError)
        console.warn("삭제된 지난 주차의 사진 정리 오류", storageError);
    }
    await this.reloadAndNotify();
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    await this.requireUserId();
    const requestId = toRequestUuid(input.clientRequestId);
    const { data, error } = await this.client.rpc("add_comment_with_mentions", {
      p_expense_id: input.expenseId,
      p_body: input.body,
      p_reply_to_comment_id: input.replyToId ?? null,
      p_client_request_id: requestId,
      p_mentions: (input.mentions ?? []).map((mention) => ({
        user_id: mention.userId,
        start_offset: mention.start,
        end_offset: mention.end,
        display_name: mention.displayName,
      })),
    });
    if (error) throw translateError(error, "댓글을 보내지 못했어요.");

    const id = requiredString(firstObject(data)?.id, "생성된 댓글 ID");
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["comments", "comment_mentions"]),
      new Set([id]),
    );
    return clone(requireComment(snapshot, id));
  }

  async updateComment(commentId: string, body: string): Promise<Comment> {
    await this.requireUserId();
    const current = await this.findCurrentComment(commentId);
    const { error } = await this.client.rpc("update_comment", {
      p_comment_id: commentId,
      p_body: body,
      p_expected_version: requireVersion(current.version, "댓글"),
    });
    if (error) throw translateError(error, "댓글을 수정하지 못했어요.");
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["comments", "comment_mentions"]),
      new Set([commentId]),
    );
    return clone(requireComment(snapshot, commentId));
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.requireUserId();
    const current = await this.findCurrentComment(commentId);
    const { error } = await this.client.rpc("delete_comment", {
      p_comment_id: commentId,
      p_expected_version: requireVersion(current.version, "댓글"),
    });
    if (error) throw translateError(error, "댓글을 삭제하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["comments", "comment_mentions"]),
      new Set([commentId]),
    );
  }

  async toggleCommentReaction(
    commentId: string,
    emoji: CommentReactionEmoji,
  ): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("toggle_comment_reaction", {
      p_comment_id: commentId,
      p_emoji: emoji,
    });
    if (error) throw translateError(error, "댓글 반응을 변경하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["comment_reactions"]),
    );
  }

  async addRoomPost(input: AddRoomPostInput): Promise<RoomPost> {
    const userId = await this.requireUserId();
    const photoPath = input.photoUri
      ? await this.uploadRoomPostPhoto(input.photoUri, userId, input.clientRequestId)
      : null;
    const { data, error } = await this.client.rpc("add_room_post", {
      p_room_id: input.roomId,
      p_kind:
        input.kind === "NOTICE"
          ? "notice"
          : input.kind === "POLL"
            ? "poll"
            : "post",
      p_category: input.category
        ? ROOM_POST_CATEGORY_TO_DATABASE[input.category]
        : null,
      p_title: input.title.trim(),
      p_body: input.body,
      p_options:
        input.kind === "POLL"
          ? (input.options?.map((option) => option.trim()) ?? [])
          : null,
      p_photo_path: photoPath,
      p_secret_purchase_amount: input.secretPurchase?.amount ?? null,
      p_secret_purchase_occurred_at: input.secretPurchase?.occurredAt ?? null,
      p_secret_purchase_category: input.secretPurchase
        ? CATEGORY_TO_DATABASE[input.secretPurchase.expenseCategory]
        : null,
      p_client_request_id: toRequestUuid(input.clientRequestId),
    });
    if (error) {
      if (photoPath) await this.removeOrphanRoomPostPhoto(photoPath);
      throw translateError(error, "기록을 남기지 못했어요.");
    }
    const id = requiredString(firstObject(data)?.id, "생성된 기록 ID");
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_posts"]),
    );
    return clone(requireRoomPost(snapshot, id));
  }

  async updateRoomPost(input: UpdateRoomPostInput): Promise<RoomPost> {
    const userId = await this.requireUserId();
    const current = await this.findCurrentRoomPost(input.postId);
    const replacementPath = input.photo.mode === "replace"
      ? await this.uploadRoomPostPhoto(
        input.photo.uri,
        userId,
        input.photo.clientRequestId,
      )
      : null;
    const photoPath = input.photo.mode === "keep"
      ? current.photoPath ?? null
      : input.photo.mode === "remove"
        ? null
        : replacementPath;
    const { error } = await this.client.rpc("update_room_post", {
      p_post_id: input.postId,
      p_category: input.category
        ? ROOM_POST_CATEGORY_TO_DATABASE[input.category]
        : null,
      p_title: input.title.trim(),
      p_body: input.body.trim(),
      p_photo_path: photoPath,
      p_secret_purchase_amount: input.secretPurchase?.amount ?? null,
      p_secret_purchase_occurred_at: input.secretPurchase?.occurredAt ?? null,
      p_secret_purchase_category: input.secretPurchase
        ? CATEGORY_TO_DATABASE[input.secretPurchase.expenseCategory]
        : null,
      p_expected_version: requireVersion(current.version, "기록"),
    });
    if (error) {
      if (replacementPath) await this.removeOrphanRoomPostPhoto(replacementPath);
      throw translateError(error, "기록을 수정하지 못했어요.");
    }
    if (current.photoPath && current.photoPath !== photoPath) {
      await this.removeOrphanRoomPostPhoto(current.photoPath);
    }
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_posts"]),
    );
    return clone(requireRoomPost(snapshot, input.postId));
  }

  async deleteRoomPost(postId: string): Promise<void> {
    await this.requireUserId();
    const current = await this.findCurrentRoomPost(postId);
    const { error } = await this.client.rpc("delete_room_post", {
      p_post_id: postId,
      p_expected_version: requireVersion(current.version, "기록"),
    });
    if (error) throw translateError(error, "기록을 삭제하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_posts"]),
    );
  }

  async addRoomPostComment(
    input: AddRoomPostCommentInput,
  ): Promise<RoomPostComment> {
    await this.requireUserId();
    const { data, error } = await this.client.rpc("add_room_post_comment", {
      p_post_id: input.postId,
      p_body: input.body,
      p_reply_to_comment_id: input.replyToId ?? null,
      p_client_request_id: toRequestUuid(input.clientRequestId),
    });
    if (error) throw translateError(error, "댓글을 남기지 못했어요.");
    const id = requiredString(firstObject(data)?.id, "생성된 댓글 ID");
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_post_comments"]),
    );
    return clone(requireRoomPostComment(snapshot, id));
  }

  async updateRoomPostComment(
    commentId: string,
    body: string,
  ): Promise<RoomPostComment> {
    await this.requireUserId();
    const current = await this.findCurrentRoomPostComment(commentId);
    const { error } = await this.client.rpc("update_room_post_comment", {
      p_comment_id: commentId,
      p_body: body,
      p_expected_version: requireVersion(current.version, "댓글"),
    });
    if (error) throw translateError(error, "댓글을 수정하지 못했어요.");
    const snapshot = await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_post_comments"]),
    );
    return clone(requireRoomPostComment(snapshot, commentId));
  }

  async deleteRoomPostComment(commentId: string): Promise<void> {
    await this.requireUserId();
    const current = await this.findCurrentRoomPostComment(commentId);
    const { error } = await this.client.rpc("delete_room_post_comment", {
      p_comment_id: commentId,
      p_expected_version: requireVersion(current.version, "댓글"),
    });
    if (error) throw translateError(error, "댓글을 삭제하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_post_comments"]),
    );
  }

  async toggleRoomPostReaction(
    postId: string,
    emoji: RoomPostReactionEmoji,
  ): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("toggle_room_post_reaction", {
      p_post_id: postId,
      p_emoji: emoji,
    });
    if (error) throw translateError(error, "반응을 변경하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_post_reactions"]),
    );
  }

  async markExpenseRead(expenseId: string): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("mark_expense_read", {
      p_expense_id: expenseId,
    });
    if (error) throw translateError(error, "지출을 읽음 처리하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["expense_reads"]),
    );
  }

  async markRoomPostRead(postId: string): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("mark_room_post_read", {
      p_post_id: postId,
    });
    if (error) throw translateError(error, "글을 읽음 처리하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_post_reads"]),
    );
  }

  async voteRoomPostPoll(postId: string, optionId: string): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.rpc("vote_room_post_poll", {
      p_post_id: postId,
      p_option_id: optionId,
    });
    if (error) throw translateError(error, "투표하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["room_post_poll_votes"]),
    );
  }

  async markNotificationsRead(
    notificationIds: readonly string[],
  ): Promise<void> {
    await this.requireUserId();
    const ids = [...new Set(notificationIds)].filter((id) => id.length > 0);
    if (ids.length === 0) return;
    const { error } = await this.client
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", ids)
      .is("read_at", null);
    if (error) throw translateError(error, "소식을 읽음 처리하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["notifications"]),
    );
  }

  async markAllNotificationsRead(): Promise<void> {
    const userId = await this.requireUserId();
    const { error } = await this.client
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("read_at", null);
    if (error)
      throw translateError(error, "모든 소식을 읽음 처리하지 못했어요.");
    await this.reloadRealtimeTablesAndNotify(
      new Set<RealtimeTable>(["notifications"]),
    );
  }

  async sendWinnerNudge(input: { roomId: string; body: string }): Promise<void> {
    await this.requireUserId();
    const { error } = await this.client.functions.invoke("send-winner-nudge", {
      body: { roomId: input.roomId, body: input.body.trim() },
    });
    if (error) throw translateError(error, "잔소리를 보내지 못했어요.");
    await this.reloadAndNotify();
  }

  subscribe(listener: (snapshot: AppSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.lastSnapshot) listener(clone(this.lastSnapshot));
    if (this.lastSnapshot && !this.realtimeChannel) {
      void this.ensureRealtime(this.lastSnapshot.currentUserId);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) void this.teardownRealtime();
    };
  }

  private async fetchSnapshot(): Promise<AppSnapshot> {
    const userId = await this.requireUserId();
    await this.ensureRealtime(userId);

    const [
      profilesResult,
      roomsResult,
      roomMembersResult,
      periodsResult,
      periodDaysResult,
      periodMembersResult,
      periodResultsResult,
      statsResult,
      invitesResult,
      expenseRows,
      expenseReadRows,
      commentRows,
      commentMentionRows,
      commentReactionRows,
      roomPostRows,
      roomPostCommentRows,
      roomPostReactionRows,
      roomPostReadRows,
      roomPostPollOptionRows,
      roomPostPollVoteRows,
      notificationRows,
      winnerNudgeGrantRows,
      exceptionRows,
      responseRows,
      preferencesResult,
    ] = await Promise.all([
      this.client
        .from("profiles")
        .select("id,nickname,avatar_key,avatar_path,nickname_changed_at"),
      this.client
        .from("rooms")
        .select(
          "id,name,owner_id,base_amount,capacity,status,created_at,closed_at",
        )
        .order("created_at", { ascending: false }),
      this.client
        .from("room_members")
        .select("room_id,user_id,role,status,joined_at,nickname_change_required")
        .order("joined_at", { ascending: true }),
      this.client
        .from("period_status_view")
        .select(
          "id,room_id,week_index,week_start,week_end,selected_day_count,valid_day_count,holiday_version_id,finalized_at,created_at,state",
        )
        .order("week_start", { ascending: false }),
      this.client.from("period_days").select("period_id,day_on,is_holiday"),
      this.client
        .from("period_members")
        .select(
          "period_id,user_id,status,joined_at,joined_on,is_late_join,eligible_day_count,applied_limit",
        )
        .order("joined_at", { ascending: true }),
      this.client
        .from("period_results")
        .select(
          "period_id,room_id,user_id,nickname_snapshot,applied_limit,spent_amount,remaining_amount,achieved,is_crown,finalized_at",
        ),
      this.client
        .from("room_member_stats")
        .select(
          "room_id,user_id,participated_week_count,achieved_week_count,crown_count,current_streak",
        ),
      this.client
        .from("invite_codes")
        .select("room_id,code,is_active")
        .eq("is_active", true),
      fetchExpenseRows(this.client),
      fetchExpenseReadRows(this.client),
      fetchCommentRows(this.client),
      fetchCommentMentionRows(this.client),
      fetchCommentReactionRows(this.client),
      fetchRoomPostRows(this.client),
      fetchRoomPostCommentRows(this.client),
      fetchRoomPostReactionRows(this.client),
      fetchRoomPostReadRows(this.client),
      fetchRoomPostPollOptionRows(this.client),
      fetchRoomPostPollVoteRows(this.client),
      fetchNotificationRows(this.client),
      fetchWinnerNudgeGrantRows(this.client),
      fetchExceptionRows(this.client),
      fetchExceptionResponseRows(this.client),
      this.client.from("user_room_preferences").select("room_id,is_hidden"),
    ]);

    const results = [
      profilesResult,
      roomsResult,
      roomMembersResult,
      periodsResult,
      periodDaysResult,
      periodMembersResult,
      periodResultsResult,
      statsResult,
      invitesResult,
      preferencesResult,
    ];
    const failed = results.find((result) => result.error);
    if (failed?.error)
      throw translateError(failed.error, "앱 데이터를 불러오지 못했어요.");

    const profileRows = rows<ProfileRow>(profilesResult.data);
    const roomRows = rows<RoomRow>(roomsResult.data);
    const roomMemberRows = rows<RoomMemberRow>(roomMembersResult.data);
    const periodRows = rows<PeriodStatusRow>(periodsResult.data);
    const periodDayRows = rows<PeriodDayRow>(periodDaysResult.data);
    const periodMemberRows = rows<PeriodMemberRow>(periodMembersResult.data);
    const periodResultRows = rows<PeriodResultRow>(periodResultsResult.data);
    const statsRows = rows<RoomMemberStatsRow>(statsResult.data);
    const inviteRows = rows<InviteCodeRow>(invitesResult.data);
    const preferenceRows = rows<PreferenceRow>(preferencesResult.data);
    const grantRows = winnerNudgeGrantRows as WinnerNudgeGrantRow[];

    const expensePhotoPaths = expenseRows
      .filter((row) => row.deleted_at === null)
      .map((row) => row.photo_path)
      .filter(isString);
    const roomPostPhotoPaths = roomPostRows
      .filter((row) => row.deleted_at === null)
      .map((row) => row.photo_path)
      .filter(isString);
    const [expenseSignedUrls, expenseThumbnailSignedUrls, avatarSignedUrls, roomPostSignedUrls] =
      await Promise.all([
        this.createSignedUrlMap("expense-photos", expensePhotoPaths),
        this.createSignedUrlMap(
          "expense-photos",
          expensePhotoPaths.map(expenseThumbnailPath),
        ),
        this.createSignedUrlMap(
          "profile-images",
          profileRows.map((row) => row.avatar_path).filter(isString),
        ),
        this.createSignedUrlMap("room-post-images", roomPostPhotoPaths),
      ]);
    this.scheduleSignedUrlRefresh(
      expenseSignedUrls.size +
        expenseThumbnailSignedUrls.size +
        avatarSignedUrls.size +
        roomPostSignedUrls.size >
        0,
    );

    const hiddenClosedIds = new Set(
      preferenceRows.filter((row) => row.is_hidden).map((row) => row.room_id),
    );
    const inviteByRoom = new Map(
      inviteRows
        .filter((row) => row.is_active)
        .map((row) => [row.room_id, row.code]),
    );
    const rooms = roomRows
      .filter((row) => row.status !== "closed" || !hiddenClosedIds.has(row.id))
      .map((row) => mapRoom(row, inviteByRoom.get(row.id)));
    const visibleRoomIds = new Set(rooms.map((room) => room.id));
    const daysByPeriod = groupBy(periodDayRows, (row) => row.period_id);
    const periods = periodRows
      .filter((row) => visibleRoomIds.has(row.room_id))
      .map((row) => mapPeriod(row, daysByPeriod.get(row.id) ?? []));
    const visiblePeriodIds = new Set(periods.map((period) => period.id));
    const visibleExpenseRows = filterVisibleExpenseRows(
      expenseRows,
      visiblePeriodIds,
    );
    const visibleExpenseIds = new Set(visibleExpenseRows.map((row) => row.id));
    const visibleCommentRows = filterVisibleCommentRows(
      commentRows,
      visibleExpenseIds,
    );
    const visibleCommentIds = new Set(visibleCommentRows.map((row) => row.id));
    const visibleRoomPostRows = roomPostRows.filter((row) =>
      visibleRoomIds.has(row.room_id),
    );
    const visibleRoomPostIds = new Set(
      visibleRoomPostRows.map((row) => row.id),
    );
    const visibleRoomPostCommentRows = roomPostCommentRows.filter((row) =>
      visibleRoomPostIds.has(row.post_id),
    );
    const visibleExceptionRows = exceptionRows.filter((row) =>
      visibleExpenseIds.has(row.expense_id),
    );
    const visibleResponseRows = responseRows.filter((row) =>
      visibleExpenseIds.has(row.expense_id),
    );

    return {
      currentUserId: userId,
      profiles: profileRows.map((row) => mapProfile(row, avatarSignedUrls)),
      rooms,
      roomMembers: roomMemberRows
        .filter((row) => visibleRoomIds.has(row.room_id))
        .map(mapRoomMember),
      periods,
      periodMembers: periodMemberRows
        .filter((row) => visiblePeriodIds.has(row.period_id))
        .map(mapPeriodMember),
      periodResults: periodResultRows
        .filter((row) => visiblePeriodIds.has(row.period_id))
        .map(mapPeriodResult),
      memberStats: statsRows
        .filter((row) => visibleRoomIds.has(row.room_id))
        .map(mapStats),
      expenses: visibleExpenseRows.map((row) =>
        mapExpense(row, expenseSignedUrls, expenseThumbnailSignedUrls),
      ),
      expenseReads: expenseReadRows
        .filter((row) => visibleExpenseIds.has(row.expense_id))
        .map(mapExpenseRead),
      comments: visibleCommentRows.map(mapComment),
      commentMentions: commentMentionRows
        .filter((row) => visibleCommentIds.has(row.comment_id))
        .map(mapCommentMention),
      commentReactions: commentReactionRows
        .filter((row) => visibleCommentIds.has(row.comment_id))
        .map(mapCommentReaction),
      roomPosts: visibleRoomPostRows.map((row) => mapRoomPost(row, roomPostSignedUrls)),
      roomPostComments: visibleRoomPostCommentRows.map(mapRoomPostComment),
      roomPostReactions: roomPostReactionRows
        .filter((row) => visibleRoomPostIds.has(row.post_id))
        .map(mapRoomPostReaction),
      roomPostReads: roomPostReadRows
        .filter((row) => visibleRoomPostIds.has(row.post_id))
        .map(mapRoomPostRead),
      roomPostPollOptions: roomPostPollOptionRows
        .filter((row) => visibleRoomPostIds.has(row.post_id))
        .map(mapRoomPostPollOption),
      roomPostPollVotes: roomPostPollVoteRows
        .filter((row) => visibleRoomPostIds.has(row.post_id))
        .map(mapRoomPostPollVote),
      notifications: notificationRows.map(mapNotification),
      winnerNudgeGrants: grantRows.map(mapWinnerNudgeGrant),
      expenseExceptions: visibleExceptionRows.map(mapExpenseException),
      expenseExceptionResponses: visibleResponseRows.map(
        mapExpenseExceptionResponse,
      ),
      processedRequestIds: collectProcessedRequestIds(
        expenseRows,
        commentRows,
        userId,
      ),
    };
  }

  private async requireUserId(): Promise<string> {
    if (this.fixedUserId) return this.fixedUserId;
    const { data, error } = await this.client.auth.getSession();
    if (error) throw translateError(error, "로그인 상태를 확인하지 못했어요.");
    if (!data.session?.user.id) {
      throw new RepositoryError("AUTH_REQUIRED", "로그인이 필요해요.");
    }
    return data.session.user.id;
  }

  private async ensureRealtime(userId: string): Promise<void> {
    if (this.listeners.size === 0) return;
    if (this.realtimeChannel && this.realtimeUserId === userId) return;
    if (this.realtimeChannel)
      await this.client.removeChannel(this.realtimeChannel);

    let channel = this.client.channel(`zaringovy:${userId}`);
    for (const table of REALTIME_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload) => {
          const record = asObject(payload.new) ?? asObject(payload.old);
          const mentionCommentId = table === "comment_mentions" && record
            ? record.comment_id
            : undefined;
          this.scheduleRealtimeReload(
            table,
            typeof mentionCommentId === "string" ? mentionCommentId : undefined,
          );
        },
      );
    }
    this.realtimeChannel = channel;
    this.realtimeUserId = userId;
    channel.subscribe((status, error) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("Supabase realtime 연결 오류", error);
      }
    });
  }

  private async teardownRealtime(): Promise<void> {
    if (this.realtimeReloadTimer) clearTimeout(this.realtimeReloadTimer);
    if (this.signedUrlRefreshTimer) clearTimeout(this.signedUrlRefreshTimer);
    this.realtimeReloadTimer = null;
    this.realtimeDirtyTables.clear();
    this.realtimeDirtyMentionCommentIds.clear();
    this.realtimeNeedsAllMentionIds = false;
    this.realtimeNeedsFullReload = false;
    this.signedUrlRefreshTimer = null;
    const channel = this.realtimeChannel;
    this.realtimeChannel = null;
    this.realtimeUserId = null;
    if (channel) {
      try {
        await this.client.removeChannel(channel);
      } catch (error) {
        console.warn("Supabase realtime 채널 정리 오류", error);
      }
    }
  }

  private scheduleRealtimeReload(
    table?: RealtimeTable,
    mentionCommentId?: string,
  ): void {
    // 테이블 없이 부르는 쪽(재로그인 등)만 전체 재조회를 뜻한다. 테이블이
    // 있으면 그 테이블만 더럽다고 표시해, 패치 가능한 조합은 부분 조회로 끝낸다.
    if (!table) {
      this.realtimeNeedsFullReload = true;
    } else {
      this.realtimeDirtyTables.add(table);
      if (table === "comment_mentions") {
        if (mentionCommentId) this.realtimeDirtyMentionCommentIds.add(mentionCommentId);
        else this.realtimeNeedsAllMentionIds = true;
      }
    }
    if (this.realtimeReloadTimer) clearTimeout(this.realtimeReloadTimer);
    this.realtimeReloadTimer = setTimeout(() => {
      this.realtimeReloadTimer = null;
      const needsFullReload = this.realtimeNeedsFullReload;
      const dirtyTables = new Set(this.realtimeDirtyTables);
      const dirtyMentionCommentIds = this.realtimeNeedsAllMentionIds
        ? null
        : new Set(this.realtimeDirtyMentionCommentIds);
      this.realtimeNeedsFullReload = false;
      this.realtimeNeedsAllMentionIds = false;
      this.realtimeDirtyTables.clear();
      this.realtimeDirtyMentionCommentIds.clear();
      const reload = needsFullReload
        ? this.reloadAndNotify()
        : this.reloadRealtimeTablesAndNotify(
          dirtyTables,
          dirtyMentionCommentIds?.size ? dirtyMentionCommentIds : undefined,
        );
      void reload.catch((error: unknown) => {
        console.warn("Supabase realtime 데이터 갱신 오류", error);
      });
    }, 120);
  }

  private scheduleSignedUrlRefresh(hasSignedUrls: boolean): void {
    if (this.signedUrlRefreshTimer) clearTimeout(this.signedUrlRefreshTimer);
    this.signedUrlRefreshTimer = null;
    if (!hasSignedUrls || this.listeners.size === 0) return;
    this.signedUrlRefreshTimer = setTimeout(() => {
      this.signedUrlRefreshTimer = null;
      if (this.listeners.size === 0) return;
      void this.reloadAndNotify().catch((error: unknown) => {
        console.warn("비공개 사진 URL 갱신 오류", error);
      });
    }, SIGNED_URL_REFRESH_MS);
  }

  private async reloadAndNotify(): Promise<AppSnapshot> {
    return this.requestReload();
  }

  private async reloadRealtimeTablesAndNotify(
    tables: ReadonlySet<RealtimeTable>,
    commentMentionIds?: ReadonlySet<string>,
  ): Promise<AppSnapshot> {
    return this.requestReload(tables, commentMentionIds);
  }

  private async requestReload(
    tables?: ReadonlySet<RealtimeTable>,
    commentMentionIds?: ReadonlySet<string>,
  ): Promise<AppSnapshot> {
    const activeJob = this.reloadJob;
    if (activeJob) {
      mergeReloadRequest(activeJob, tables, commentMentionIds);
      return clone(await activeJob.promise);
    }

    let job: ReloadJob;
    const promise = Promise.resolve().then(() => this.drainReloadRequests(job));
    job = {
      isFullReloadInFlight: false,
      needsFullReload: tables === undefined,
      promise,
      tables: new Set(tables),
      commentMentionIds:
        tables?.has("comment_mentions")
          ? commentMentionIds ? new Set(commentMentionIds) : null
          : new Set(),
    };
    this.reloadJob = job;
    void promise.then(
      () => {
        if (this.reloadJob === job) this.reloadJob = null;
      },
      () => {
        if (this.reloadJob === job) this.reloadJob = null;
      },
    );
    return clone(await promise);
  }

  private async drainReloadRequests(job: ReloadJob): Promise<AppSnapshot> {
    let latestSnapshot: AppSnapshot | null = null;
    let workingSnapshot = this.lastSnapshot;
    while (job.needsFullReload || job.tables.size > 0) {
      const needsFullReload = job.needsFullReload;
      const tables = new Set(job.tables);
      const commentMentionIds = job.commentMentionIds === null
        ? undefined
        : new Set(job.commentMentionIds);
      job.needsFullReload = false;
      job.tables.clear();
      job.commentMentionIds = new Set();
      // A mutation can race an older in-flight load. Let that load settle, then
      // fetch once more so the emitted state always includes the committed row.
      if (this.loading) await this.loading.catch(() => undefined);
      const generation = this.authGeneration;
      job.isFullReloadInFlight = needsFullReload;
      let snapshot: AppSnapshot;
      try {
        snapshot = needsFullReload
          ? await this.fetchSnapshot()
          : await this.fetchRealtimeSnapshot(
            tables,
            workingSnapshot,
            commentMentionIds,
          );
      } finally {
        job.isFullReloadInFlight = false;
      }
      this.assertCurrentAuthSnapshot(snapshot, generation);
      if (this.reloadJob !== job) {
        throw new RepositoryError(
          "SESSION_CHANGED",
          "로그인 사용자가 바뀌었어요. 현재 계정의 데이터를 다시 불러와 주세요.",
        );
      }
      latestSnapshot = snapshot;
      workingSnapshot = snapshot;
      // New dirty/full requests may have arrived while the fetch was running.
      // Do not expose an internally inconsistent intermediate snapshot; the
      // next iteration patches from this working copy and only the final state
      // is committed below.
      if (job.needsFullReload || job.tables.size > 0) continue;
      this.lastSnapshot = snapshot;
      this.listeners.forEach((listener) => listener(clone(snapshot)));
    }
    if (!latestSnapshot) {
      throw new RepositoryError(
        "RELOAD_CANCELLED",
        "데이터 갱신 요청이 취소됐어요.",
      );
    }
    return latestSnapshot;
  }

  private async fetchRealtimeSnapshot(
    tables: ReadonlySet<RealtimeTable>,
    baseSnapshot: AppSnapshot | null = this.lastSnapshot,
    commentMentionIds?: ReadonlySet<string>,
  ): Promise<AppSnapshot> {
    const canPatchSnapshot = [...tables].every(
      (table) =>
        table === "expenses" ||
        table === "expense_reads" ||
        table === "comments" ||
        table === "comment_mentions" ||
        table === "comment_reactions" ||
        table === "expense_exceptions" ||
        table === "expense_exception_approvals" ||
        table === "room_post_reads",
    );
    const previous = baseSnapshot;
    if (!previous || !canPatchSnapshot || tables.size === 0) {
      return this.fetchSnapshot();
    }

    const userId = await this.requireUserId();
    const shouldFetchExpenses = tables.has("expenses");
    const shouldFetchComments = tables.has("comments");
    const shouldFetchCommentMentions = tables.has("comment_mentions");
    const hasScopedMentionIds = Boolean(commentMentionIds?.size);
    const shouldFetchCommentReactions = tables.has("comment_reactions");
    const shouldFetchExceptions = tables.has("expense_exceptions");
    const shouldFetchResponses = tables.has("expense_exception_approvals");
    const shouldFetchExpenseReads = tables.has("expense_reads");
    const shouldFetchRoomPostReads = tables.has("room_post_reads");
    const [
      expenseRows,
      commentRows,
      commentMentionRows,
      commentReactionRows,
      exceptionRows,
      responseRows,
      expenseReadRows,
      roomPostReadRows,
    ] = await Promise.all([
      shouldFetchExpenses
        ? fetchExpenseRows(this.client)
        : Promise.resolve(null),
      shouldFetchComments
        ? fetchCommentRows(this.client)
        : Promise.resolve(null),
      shouldFetchCommentMentions
        ? fetchCommentMentionRows(
            this.client,
            hasScopedMentionIds ? [...commentMentionIds!] : undefined,
          )
        : Promise.resolve(null),
      shouldFetchCommentReactions
        ? fetchCommentReactionRows(this.client)
        : Promise.resolve(null),
      shouldFetchExceptions
        ? fetchExceptionRows(this.client)
        : Promise.resolve(null),
      shouldFetchResponses
        ? fetchExceptionResponseRows(this.client)
        : Promise.resolve(null),
      shouldFetchExpenseReads
        ? fetchExpenseReadRows(this.client)
        : Promise.resolve(null),
      shouldFetchRoomPostReads
        ? fetchRoomPostReadRows(this.client)
        : Promise.resolve(null),
    ]);

    const visiblePeriodIds = new Set(
      previous.periods.map((period) => period.id),
    );
    const visibleExpenseRows = expenseRows
      ? filterVisibleExpenseRows(expenseRows, visiblePeriodIds)
      : null;
    let expenses = previous.expenses;
    if (visibleExpenseRows) {
      const expenseSignedUrls = new Map<string, string>();
      const expenseThumbnailSignedUrls = new Map<string, string>();
      previous.expenses.forEach((expense) => {
        if (expense.photoPath && expense.photoUri) {
          expenseSignedUrls.set(expense.photoPath, expense.photoUri);
        }
        if (expense.photoPath && expense.photoThumbnailUri) {
          expenseThumbnailSignedUrls.set(
            expenseThumbnailPath(expense.photoPath),
            expense.photoThumbnailUri,
          );
        }
      });
      const unsignedPaths = visibleExpenseRows
        .filter((row) => row.deleted_at === null)
        .map((row) => row.photo_path)
        .filter(isString)
        .filter((path) => !expenseSignedUrls.has(path));
      const unsignedThumbnailPaths = visibleExpenseRows
        .filter((row) => row.deleted_at === null)
        .map((row) => row.photo_path)
        .filter(isString)
        .map(expenseThumbnailPath)
        .filter((path) => !expenseThumbnailSignedUrls.has(path));
      const [newSignedUrls, newThumbnailSignedUrls] = await Promise.all([
        this.createSignedUrlMap("expense-photos", unsignedPaths),
        this.createSignedUrlMap("expense-photos", unsignedThumbnailPaths),
      ]);
      newSignedUrls.forEach((url, path) => expenseSignedUrls.set(path, url));
      newThumbnailSignedUrls.forEach((url, path) =>
        expenseThumbnailSignedUrls.set(path, url),
      );
      expenses = visibleExpenseRows.map((row) =>
        mapExpense(row, expenseSignedUrls, expenseThumbnailSignedUrls),
      );
      if (expenseSignedUrls.size + expenseThumbnailSignedUrls.size > 0) {
        this.scheduleSignedUrlRefresh(true);
      }
    }

    const visibleExpenseIds = new Set(expenses.map((expense) => expense.id));
    const expensesChanged = visibleExpenseRows !== null;
    const comments = commentRows
      ? filterVisibleCommentRows(commentRows, visibleExpenseIds).map(mapComment)
      : expensesChanged
        ? previous.comments.filter((comment) =>
            visibleExpenseIds.has(comment.expenseId),
          )
        : previous.comments;
    const visibleCommentIds = new Set(comments.map((comment) => comment.id));
    const commentMentions = commentMentionRows
      ? hasScopedMentionIds
        ? [
            ...previous.commentMentions.filter(
              (mention) => !commentMentionIds!.has(mention.commentId)
                && visibleCommentIds.has(mention.commentId),
            ),
            ...commentMentionRows
              .filter((row) => visibleCommentIds.has(row.comment_id))
              .map(mapCommentMention),
          ]
        : commentMentionRows
            .filter((row) => visibleCommentIds.has(row.comment_id))
            .map(mapCommentMention)
      : comments !== previous.comments
        ? previous.commentMentions.filter((mention) =>
            visibleCommentIds.has(mention.commentId),
          )
        : previous.commentMentions;
    const commentReactions = commentReactionRows
      ? commentReactionRows
          .filter((row) => visibleCommentIds.has(row.comment_id))
          .map(mapCommentReaction)
      : comments !== previous.comments
        ? previous.commentReactions.filter((reaction) =>
            visibleCommentIds.has(reaction.commentId),
          )
        : previous.commentReactions;
    // Exceptions/responses live in their own arrays keyed by expense_id, so a
    // patch either refetches the touched table or re-filters the carried-over
    // rows against the (possibly shrunk) visible expense set.
    const expenseExceptions = exceptionRows
      ? exceptionRows
          .filter((row) => visibleExpenseIds.has(row.expense_id))
          .map(mapExpenseException)
      : expensesChanged
        ? previous.expenseExceptions.filter((row) =>
            visibleExpenseIds.has(row.expenseId),
          )
        : previous.expenseExceptions;
    const expenseExceptionResponses = responseRows
      ? responseRows
          .filter((row) => visibleExpenseIds.has(row.expense_id))
          .map(mapExpenseExceptionResponse)
      : expensesChanged
        ? previous.expenseExceptionResponses.filter((row) =>
            visibleExpenseIds.has(row.expenseId),
          )
        : previous.expenseExceptionResponses;
    // 읽음 행은 expense_id/post_id로만 묶이므로, 해당 테이블을 다시 읽었거나
    // 지출이 줄어 안 보이게 된 경우에만 다시 거른다.
    const expenseReads = expenseReadRows
      ? expenseReadRows
          .filter((row) => visibleExpenseIds.has(row.expense_id))
          .map(mapExpenseRead)
      : expensesChanged
        ? (previous.expenseReads ?? []).filter((read) =>
            visibleExpenseIds.has(read.expenseId),
          )
        : previous.expenseReads;
    const visibleRoomPostIds = new Set(previous.roomPosts.map((post) => post.id));
    const roomPostReads = roomPostReadRows
      ? roomPostReadRows
          .filter((row) => visibleRoomPostIds.has(row.post_id))
          .map(mapRoomPostRead)
      : previous.roomPostReads;
    const processedRequestIds = new Set(previous.processedRequestIds);
    collectProcessedRequestIds(
      expenseRows ?? [],
      commentRows ?? [],
      userId,
    ).forEach((requestId) => processedRequestIds.add(requestId));

    return {
      ...previous,
      currentUserId: userId,
      expenses,
      expenseReads,
      comments,
      commentMentions,
      commentReactions,
      expenseExceptions,
      expenseExceptionResponses,
      roomPostReads,
      processedRequestIds: [...processedRequestIds],
    };
  }

  private assertCurrentAuthSnapshot(
    snapshot: AppSnapshot,
    generation: number,
  ): void {
    if (
      generation !== this.authGeneration ||
      this.authUserId === null ||
      (this.authUserId !== undefined &&
        snapshot.currentUserId !== this.authUserId)
    ) {
      throw new RepositoryError(
        "SESSION_CHANGED",
        "로그인 사용자가 바뀌었어요. 현재 계정의 데이터를 다시 불러와 주세요.",
      );
    }
  }

  private async findCurrentExpense(expenseId: string): Promise<Expense> {
    const snapshot = this.lastSnapshot ?? (await this.load());
    return requireExpense(snapshot, expenseId);
  }

  private async findCurrentComment(commentId: string): Promise<Comment> {
    const snapshot = this.lastSnapshot ?? (await this.load());
    return requireComment(snapshot, commentId);
  }

  private async findCurrentRoomPost(postId: string): Promise<RoomPost> {
    const snapshot = this.lastSnapshot ?? (await this.load());
    return requireRoomPost(snapshot, postId);
  }

  private async findCurrentRoomPostComment(
    commentId: string,
  ): Promise<RoomPostComment> {
    const snapshot = this.lastSnapshot ?? (await this.load());
    return requireRoomPostComment(snapshot, commentId);
  }

  private async uploadExpensePhoto(
    uri: string,
    periodId: string | undefined,
    userId: string,
    objectStem: string,
    expectedPath?: string,
  ): Promise<string> {
    const file = await readPhoto(uri);
    if (file.buffer.byteLength > MAX_EXPENSE_PHOTO_BYTES) {
      throw new RepositoryError(
        "PHOTO_TOO_LARGE",
        "지출 사진은 10MB 이하여야 해요.",
      );
    }
    const path =
      expectedPath ??
      `${periodId ?? "personal"}/${userId}/${safeObjectStem(objectStem)}.${file.extension}`;
    const { error } = await this.client.storage
      .from("expense-photos")
      .upload(path, file.buffer, {
        cacheControl: "3600",
        contentType: file.contentType,
        upsert: false,
      });
    if (error && !isAlreadyExistsError(error)) {
      throw translateError(error, "사진을 업로드하지 못했어요.");
    }
    try {
      const { createExpensePhotoThumbnail } =
        await import("@/shared/services/expense-photo-transform");
      const thumbnailUri = await createExpensePhotoThumbnail(uri);
      const thumbnail = await readPhoto(thumbnailUri);
      const thumbnailPath = expenseThumbnailPath(path);
      const { error: thumbnailError } = await this.client.storage
        .from("expense-photos")
        .upload(thumbnailPath, thumbnail.buffer, {
          cacheControl: "3600",
          contentType: thumbnail.contentType,
          upsert: false,
        });
      if (thumbnailError && !isAlreadyExistsError(thumbnailError)) {
        throw translateError(
          thumbnailError,
          "목록용 사진을 업로드하지 못했어요.",
        );
      }
    } catch (error) {
      await this.removeOrphanPhoto(path);
      throw error;
    }
    return path;
  }

  private async uploadRoomPostPhoto(
    uri: string,
    userId: string,
    clientRequestId: string,
  ): Promise<string> {
    const file = await readPhoto(uri);
    if (file.buffer.byteLength > MAX_ROOM_POST_PHOTO_BYTES) {
      throw new RepositoryError("PHOTO_TOO_LARGE", "게시글 사진은 10MB 이하여야 해요.");
    }
    const path = `${userId}/${safeObjectStem(clientRequestId)}.${file.extension}`;
    const { error } = await this.client.storage
      .from("room-post-images")
      .upload(path, file.buffer, {
        cacheControl: "3600",
        contentType: file.contentType,
        upsert: false,
      });
    if (error && !isAlreadyExistsError(error)) {
      throw translateError(error, "게시글 사진을 업로드하지 못했어요.");
    }
    return path;
  }

  private async uploadProfilePhoto(
    uri: string,
    userId: string,
  ): Promise<string> {
    const file = await readPhoto(uri);
    if (file.buffer.byteLength > MAX_PROFILE_PHOTO_BYTES) {
      throw new RepositoryError(
        "PHOTO_TOO_LARGE",
        "프로필 사진은 5MB 이하여야 해요.",
      );
    }
    const path = `${userId}/${makeUuid()}.${file.extension}`;
    const { error } = await this.client.storage
      .from("profile-images")
      .upload(path, file.buffer, {
        cacheControl: "3600",
        contentType: file.contentType,
        upsert: false,
      });
    if (error)
      throw translateError(error, "프로필 사진을 업로드하지 못했어요.");
    return path;
  }

  private async removeOrphanPhoto(path: string): Promise<void> {
    try {
      await this.cleanupExpensePhoto(path);
    } catch (error) {
      console.warn("교체 또는 삭제된 사진 정리 오류", error);
    }
  }

  private async removeOrphanProfilePhoto(path: string): Promise<void> {
    try {
      const { error } = await this.client.storage
        .from("profile-images")
        .remove([path]);
      if (error) throw error;
    } catch (error) {
      console.warn("교체 또는 삭제된 프로필 사진 정리 오류", error);
    }
  }

  private async removeOrphanRoomPostPhoto(path: string): Promise<void> {
    try {
      const { error } = await this.client.storage
        .from("room-post-images")
        .remove([path]);
      if (error) throw error;
    } catch (error) {
      console.warn("생성되지 않은 게시글 사진 정리 오류", error);
    }
  }

  private async createSignedUrlMap(
    bucket: string,
    paths: string[],
  ): Promise<Map<string, string>> {
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 0) return new Map();
    const signedUrls = new Map<string, string>();
    for (let offset = 0; offset < uniquePaths.length; offset += 100) {
      const chunk = uniquePaths.slice(offset, offset + 100);
      const { data, error } = await this.client.storage
        .from(bucket)
        .createSignedUrls(chunk, SIGNED_URL_TTL_SECONDS);
      if (error) {
        console.warn(`${bucket} 서명 URL 생성 오류`, error);
        continue;
      }
      data?.forEach((entry, index) => {
        if (entry.signedUrl)
          signedUrls.set(entry.path || chunk[index], entry.signedUrl);
      });
    }
    return signedUrls;
  }
}
