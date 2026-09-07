import type {
  AppNotification,
  Comment,
  CommentMention,
  CommentReaction,
  Expense,
  ExpenseException,
  ExpenseExceptionResponse,
  ExpenseRead,
  InvitePreview,
  Period,
  PeriodMember,
  PeriodResult,
  Profile,
  Room,
  RoomMember,
  RoomMemberStats,
  RoomPost,
  RoomPostCategory,
  RoomPostComment,
  RoomPostPollOption,
  RoomPostPollVote,
  RoomPostReaction,
  RoomPostRead,
} from "@/shared/api/types";
import { ANIMAL_AVATARS } from "@/shared/config/animals";
import type {
  LocalDate,
  MemberStatus,
  PeriodPhase,
} from "@/shared/model/types";
import { RepositoryError } from "./errors";
import { asObject } from "./json";
import type {
  CommentReactionRow,
  CommentRow,
  ExpenseExceptionResponseRow,
  ExpenseExceptionRow,
  ExpenseReadRow,
  ExpenseRow,
  JsonObject,
  NotificationRow,
  PeriodDayRow,
  PeriodMemberRow,
  PeriodResultRow,
  PeriodStatusRow,
  ProfileRow,
  RoomMemberRow,
  RoomMemberStatsRow,
  RoomPostCommentRow,
  RoomPostPollOptionRow,
  RoomPostPollVoteRow,
  RoomPostReactionRow,
  RoomPostReadRow,
  RoomPostRow,
  RoomRow,
} from "./rows";
import { CATEGORY_FROM_DATABASE } from "./rows";

/** DB 행을 앱 타입으로 옮긴다. 네트워크도 상태도 없는 순수 함수들이다. */

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RepositoryError(
      "INVALID_RESPONSE",
      `${label} 응답이 올바르지 않아요.`,
    );
  }
  return value;
}

export function safeNumber(value: unknown, label: string): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number)) {
    throw new RepositoryError(
      "INVALID_RESPONSE",
      `${label} 응답이 올바르지 않아요.`,
    );
  }
  return number;
}

/** remaining_amount can legitimately be negative when a member overspends. */

export function safeSignedNumber(value: unknown, label: string): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number)) {
    throw new RepositoryError(
      "INVALID_RESPONSE",
      `${label} 응답이 올바르지 않아요.`,
    );
  }
  return number;
}

export function asLocalDate(value: string): LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new RepositoryError(
      "INVALID_RESPONSE",
      "날짜 응답 형식이 올바르지 않아요.",
    );
  }
  return value as LocalDate;
}

export function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function defaultAvatar(id: string): string {
  // 사용자 UUID 해시로 동물 아이콘 10종 중 하나를 결정론적(≈랜덤)으로 배정한다.
  return ANIMAL_AVATARS[hash32(id) % ANIMAL_AVATARS.length];
}

export function mapProfile(
  row: ProfileRow,
  signedUrls: Map<string, string>,
): Profile {
  const avatarPath = row.avatar_path ?? undefined;
  const avatarKey = row.avatar_key ?? undefined;
  return {
    id: row.id,
    nickname: row.nickname,
    avatarKey,
    avatar: avatarKey ?? defaultAvatar(row.id),
    avatarPath,
    avatarUri: avatarPath ? signedUrls.get(avatarPath) : undefined,
    nicknameChangeAvailableAt: row.nickname_changed_at
      ? new Date(
          Date.parse(row.nickname_changed_at) + 7 * 24 * 60 * 60 * 1_000,
        ).toISOString()
      : undefined,
  };
}

export function mapRoom(row: RoomRow, inviteCode?: string): Room {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    inviteCode: inviteCode ?? "",
    baseAmount: safeNumber(row.base_amount, "기준 금액"),
    capacity: row.capacity,
    status: row.status === "closed" ? "CLOSED" : "OPEN",
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined,
  };
}

export function mapRoomMember(row: RoomMemberRow): RoomMember {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    role: row.role === "owner" ? "OWNER" : "MEMBER",
    status: mapMemberStatus(row.status),
    joinedAt: row.joined_at,
    nicknameChangeRequired: row.nickname_change_required === true,
  };
}

export function mapPeriod(row: PeriodStatusRow, days: PeriodDayRow[]): Period {
  const sortedDays = [...days].sort((left, right) =>
    left.day_on.localeCompare(right.day_on),
  );
  return {
    id: row.id,
    roomId: row.room_id,
    weekIndex: row.week_index,
    weekStart: asLocalDate(row.week_start),
    weekEnd: asLocalDate(row.week_end),
    selectedDayCount: row.selected_day_count,
    validDayCount: row.valid_day_count,
    holidayDates: sortedDays
      .filter((day) => day.is_holiday)
      .map((day) => asLocalDate(day.day_on)),
    holidayVersionId: row.holiday_version_id,
    phase: mapPhase(row.state),
    isRestWeek: row.valid_day_count === 0,
    finalizedAt: row.finalized_at ?? undefined,
    createdAt: row.created_at,
  };
}

export function mapPeriodMember(row: PeriodMemberRow): PeriodMember {
  return {
    periodId: row.period_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
    joinedDate: asLocalDate(row.joined_on),
    eligibleDayCount: row.eligible_day_count,
    appliedLimit: safeNumber(row.applied_limit, "적용 한도"),
    status: mapMemberStatus(row.status),
    isLateJoiner: row.is_late_join,
  };
}

export function mapPeriodResult(row: PeriodResultRow): PeriodResult {
  return {
    periodId: row.period_id,
    roomId: row.room_id,
    userId: row.user_id,
    nickname: row.nickname_snapshot,
    appliedLimit: safeNumber(row.applied_limit, "적용 한도"),
    spentAmount: safeNumber(row.spent_amount, "지출 합계"),
    remainingAmount: safeSignedNumber(row.remaining_amount, "잔액"),
    achieved: row.achieved,
    isCrown: row.is_crown,
    finalizedAt: row.finalized_at,
  };
}

export function mapStats(row: RoomMemberStatsRow): RoomMemberStats {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    participatedWeekCount: row.participated_week_count,
    achievedWeekCount: row.achieved_week_count,
    crownCount: row.crown_count,
    currentStreak: row.current_streak,
  };
}

export function mapNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    actorId: row.actor_id ?? undefined,
    roomId: row.room_id ?? undefined,
    periodId: row.period_id ?? undefined,
    expenseId: row.expense_id ?? undefined,
    commentId: row.comment_id ?? undefined,
    postId: row.post_id ?? undefined,
    route: row.route,
    readAt: row.read_at ?? undefined,
    createdAt: row.created_at,
  };
}

export function mapExpense(
  row: ExpenseRow,
  signedUrls: Map<string, string>,
  thumbnailSignedUrls: Map<string, string> = new Map(),
): Expense {
  const photoPath = row.photo_path ?? undefined;
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    periodId: row.period_id ?? undefined,
    userId: row.user_id,
    amount: safeNumber(row.amount, "지출 금액"),
    pointAmount: safeNumber(row.point_amount, "포인트 사용 금액"),
    category: CATEGORY_FROM_DATABASE[row.category],
    memo: row.memo ?? "",
    photoPath,
    photoThumbnailUri: photoPath
      ? thumbnailSignedUrls.get(expenseThumbnailPath(photoPath))
      : undefined,
    photoUri: photoPath ? signedUrls.get(photoPath) : undefined,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    syncStatus: "SYNCED",
    version: row.version,
  };
}

export function expenseThumbnailPath(photoPath: string): string {
  const extensionIndex = photoPath.lastIndexOf(".");
  const pathStart = photoPath.lastIndexOf("/") + 1;
  const stem =
    extensionIndex >= pathStart
      ? photoPath.slice(0, extensionIndex)
      : photoPath;
  return `${stem}.thumb.jpg`;
}

export function mapComment(row: CommentRow): Comment {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    expenseId: row.expense_id,
    userId: row.user_id,
    body: row.deleted_at ? "삭제된 메시지입니다." : (row.body ?? ""),
    replyToId: row.reply_to_comment_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    syncStatus: "SYNCED",
    version: row.version,
  };
}

export function mapCommentReaction(row: CommentReactionRow): CommentReaction {
  return {
    commentId: row.comment_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: row.created_at,
  };
}

export function mapCommentMention(
  row: import("./rows").CommentMentionRow,
): CommentMention {
  return {
    commentId: row.comment_id,
    userId: row.mentioned_user_id,
    start: row.start_offset,
    end: row.end_offset,
    displayName: row.display_name,
  };
}

export function mapRoomPost(
  row: RoomPostRow,
  signedUrls: Map<string, string> = new Map(),
): RoomPost {
  const photoPath = row.photo_path ?? undefined;
  const secretPurchase = row.secret_purchase_amount === null
    ? undefined
    : {
      amount: safeNumber(row.secret_purchase_amount, "뒷구매 금액"),
      occurredAt: requiredString(row.secret_purchase_occurred_at, "뒷구매 일시"),
      expenseCategory: CATEGORY_FROM_DATABASE[
        requiredString(row.secret_purchase_category, "뒷구매 분류") as keyof typeof CATEGORY_FROM_DATABASE
      ],
    };
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    roomId: row.room_id,
    periodId: row.period_id ?? undefined,
    kind:
      row.kind === "notice" ? "NOTICE" : row.kind === "poll" ? "POLL" : "POST",
    category: mapRoomPostCategory(row.category),
    authorId: row.author_id,
    title: row.title,
    body: row.deleted_at ? "삭제된 기록입니다." : (row.body ?? ""),
    ...(row.poll_closes_at ? { pollClosesAt: row.poll_closes_at } : {}),
    photoPath,
    photoUri: photoPath ? signedUrls.get(photoPath) : undefined,
    secretPurchase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    version: row.version,
  };
}

export function mapExpenseRead(row: ExpenseReadRow): ExpenseRead {
  return { expenseId: row.expense_id, userId: row.user_id, readAt: row.read_at };
}

export function mapRoomPostRead(row: RoomPostReadRow): RoomPostRead {
  return { postId: row.post_id, userId: row.user_id, readAt: row.read_at };
}

function mapRoomPostCategory(
  category: RoomPostRow["category"],
): RoomPostCategory | undefined {
  if (category === null) return undefined;
  const categories: Record<Exclude<RoomPostRow["category"], null>, RoomPostCategory> = {
    frugality: "거지력",
    secret_purchase: "뒷구매",
    chat: "잡담",
  };
  return categories[category];
}

export function mapRoomPostComment(row: RoomPostCommentRow): RoomPostComment {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    postId: row.post_id,
    authorId: row.author_id,
    body: row.deleted_at ? "삭제된 댓글입니다." : (row.body ?? ""),
    replyToId: row.reply_to_comment_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    version: row.version,
  };
}

export function mapRoomPostReaction(
  row: RoomPostReactionRow,
): RoomPostReaction {
  return {
    postId: row.post_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: row.created_at,
  };
}

export function mapRoomPostPollOption(
  row: RoomPostPollOptionRow,
): RoomPostPollOption {
  return {
    id: row.id,
    postId: row.post_id,
    body: row.body,
    position: row.position,
  };
}

export function mapRoomPostPollVote(
  row: RoomPostPollVoteRow,
): RoomPostPollVote {
  return {
    postId: row.post_id,
    optionId: row.option_id,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

export function mapExpenseException(
  row: ExpenseExceptionRow,
): ExpenseException {
  return {
    expenseId: row.expense_id,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
  };
}

export function mapExpenseExceptionResponse(
  row: ExpenseExceptionResponseRow,
): ExpenseExceptionResponse {
  return {
    expenseId: row.expense_id,
    userId: row.user_id,
    decision: row.decision === "held" ? "HELD" : "APPROVED",
    createdAt: row.created_at,
  };
}

export function mapInvitePreview(
  code: string,
  payload: JsonObject,
): InvitePreview {
  const room = asObject(payload.room);
  const join = asObject(payload.join);
  if (!room || !join)
    throw new RepositoryError(
      "INVALID_RESPONSE",
      "초대 정보 형식이 올바르지 않아요.",
    );
  const period = asObject(payload.current_period);
  const holidays = Array.isArray(period?.holidays) ? period.holidays : [];
  return {
    code,
    roomId: requiredString(room.id, "방 ID"),
    name: requiredString(room.name, "방 이름"),
    baseAmount: safeNumber(room.base_amount, "기준 금액"),
    capacity: safeNumber(room.capacity, "정원"),
    memberCount: safeNumber(room.member_count, "현재 인원"),
    currentPeriod: period
      ? {
          id: requiredString(period.id, "주차 ID"),
          weekStart: asLocalDate(
            requiredString(period.week_start, "주차 시작일"),
          ),
          weekEnd: asLocalDate(requiredString(period.week_end, "주차 종료일")),
          selectedDayCount: safeNumber(period.selected_day_count, "선택 일수"),
          validDayCount: safeNumber(period.valid_day_count, "유효 일수"),
          holidayDates: holidays
            .map(asObject)
            .filter((holiday): holiday is JsonObject => Boolean(holiday))
            .map((holiday) =>
              asLocalDate(requiredString(holiday.date, "공휴일")),
            ),
        }
      : undefined,
    joinedDate: asLocalDate(requiredString(join.joined_on, "합류일")),
    eligibleDayCount: safeNumber(join.eligible_day_count, "남은 유효 일수"),
    appliedLimit: safeNumber(join.applied_limit, "적용 한도"),
    isLateJoiner: join.is_late_join === true,
    participatesThisWeek: join.participates_this_week === true,
    canJoin: join.can_join === true,
  };
}

export function mapPhase(state: PeriodStatusRow["state"]): PeriodPhase {
  if (state === "settling") return "SETTLEMENT";
  return state.toUpperCase() as PeriodPhase;
}

export function mapMemberStatus(status: RoomMemberRow["status"]): MemberStatus {
  return status.toUpperCase() as MemberStatus;
}
