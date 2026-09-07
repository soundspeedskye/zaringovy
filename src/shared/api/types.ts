import type {
  ExpenseCategory,
  LocalDate,
  MemberStatus,
  PeriodPhase,
} from "@/shared/model/types";

export type SyncStatus = "SYNCED" | "PENDING" | "FAILED";

export type Profile = {
  id: string;
  nickname: string;
  /** 사용자가 직접 고른 동물 키. 없으면 id 기반 기본 동물을 사용한다. */
  avatarKey?: string;
  avatar: string;
  /** Short-lived URL for a private profile image, when one is configured. */
  avatarUri?: string;
  /** Private Storage object path; never render this value directly. */
  avatarPath?: string;
  /** 마지막 닉네임 변경 후 다시 변경할 수 있는 서버 기준 시각. */
  nicknameChangeAvailableAt?: string;
};

export type RoomStatus = "OPEN" | "CLOSED";
export type RoomRole = "OWNER" | "MEMBER";

/** 방: 고정 설정 + 멤버십 + 초대의 소유자. 주차별 타임라인은 Period에 있다. */
export type Room = {
  id: string;
  ownerId: string;
  name: string;
  inviteCode: string;
  /** 주당 기준금액 (D2: 방 생성 시 고정). */
  baseAmount: number;
  capacity: number;
  status: RoomStatus;
  createdAt: string;
  closedAt?: string;
  clientRequestId?: string;
};

/** 방 멤버십(영속). 탈퇴 전까지 모든 주차에 자동 참여한다. */
export type RoomMember = {
  roomId: string;
  userId: string;
  role: RoomRole;
  status: MemberStatus;
  joinedAt: string;
  /**
   * 먼저 참여한 같은 닉네임의 활성 멤버가 있어, 닉네임을 바꾸기 전까지 이 방에서
   * 참여성 쓰기를 할 수 없는 상태. 서버(room_members)가 들고 있으므로 앱을 다시
   * 켜도 유지된다.
   */
  nicknameChangeRequired: boolean;
};

/** 주차: 월~금 고정 주간 타임라인 (D1). 매주 자동 생성된다 (D7). */
export type Period = {
  id: string;
  roomId: string;
  weekIndex: number;
  weekStart: LocalDate;
  weekEnd: LocalDate;
  selectedDayCount: number;
  validDayCount: number;
  holidayDates: LocalDate[];
  holidayVersionId: string;
  phase: PeriodPhase;
  /** D5: 유효일 0인 쉬는 주. 참여자·결과·streak에 포함되지 않는다. */
  isRestWeek: boolean;
  finalizedAt?: string;
  createdAt: string;
};

/** 주차 참여자: 주차별 일할 한도 (D3/D6 proration). */
export type PeriodMember = {
  periodId: string;
  userId: string;
  joinedAt: string;
  joinedDate: LocalDate;
  eligibleDayCount: number;
  appliedLimit: number;
  status: MemberStatus;
  isLateJoiner: boolean;
};

/** 주차별 정산 스냅샷 (F 시점 확정). */
export type PeriodResult = {
  periodId: string;
  roomId: string;
  userId: string;
  nickname: string;
  appliedLimit: number;
  spentAmount: number;
  remainingAmount: number;
  achieved: boolean;
  isCrown: boolean;
  finalizedAt: string;
};

/** 누적 통계 (D4): 쉬는 주는 집계·streak 모두 제외. */
export type RoomMemberStats = {
  roomId: string;
  userId: string;
  participatedWeekCount: number;
  achievedWeekCount: number;
  crownCount: number;
  currentStreak: number;
};

export type Expense = {
  id: string;
  clientRequestId: string;
  /** 지출이 귀속되는 주차. 비우면 개인 지출. */
  periodId?: string;
  userId: string;
  /** 실제 예산에서 차감되는 결제 금액. */
  amount: number;
  /** 포인트 사용액. 표시용이며 챌린지 예산 합계에는 포함하지 않는다. */
  pointAmount: number;
  category: ExpenseCategory;
  memo: string;
  /** Small signed rendition used by feed cards; falls back to photoUri for legacy photos. */
  photoThumbnailUri?: string;
  photoUri?: string;
  /** Private Storage object path; never rendered directly. */
  photoPath?: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  syncStatus: SyncStatus;
  /** Local mutation represented by this optimistic/failed projection. */
  syncOperation?: "ADD" | "UPDATE" | "DELETE";
  /** Last server-confirmed amount while UPDATE/DELETE is not yet applied. */
  serverAmount?: number;
  /** Last server-confirmed category while UPDATE is projected locally. */
  serverCategory?: ExpenseCategory;
  version?: number;
};

export type Comment = {
  id: string;
  clientRequestId: string;
  expenseId: string;
  userId: string;
  body: string;
  replyToId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  syncStatus: SyncStatus;
  version?: number;
};

/** 댓글 본문 안에서 실제 멤버를 가리키는 @멘션. 위치는 Unicode code point 기준이다. */
export type CommentMention = {
  commentId: string;
  userId: string;
  start: number;
  end: number;
  displayName: string;
};

export type CommentMentionInput = Omit<CommentMention, "commentId">;

export const COMMENT_REACTION_EMOJIS = [
  "🩷",
  "👍",
  "👎",
  "🤔",
  "✌️",
  "👏",
  "🫠",
  "🥰",
  "🥲",
] as const;
export type CommentReactionEmoji = (typeof COMMENT_REACTION_EMOJIS)[number];

/** 첫 번째 반응 메뉴에 보여 줄 대표 아이콘. */
export const QUICK_COMMENT_REACTION_EMOJIS = ["🩷", "👍", "👎", "🤔"] as const satisfies readonly CommentReactionEmoji[];

/** 한 사용자가 댓글에 남긴 이모지 반응. 같은 이모지는 댓글당 한 번만 가능하다. */
export type CommentReaction = {
  commentId: string;
  userId: string;
  emoji: CommentReactionEmoji;
  createdAt: string;
};

export type RoomPostKind = "NOTICE" | "POST" | "POLL";
export const ROOM_POST_CATEGORIES = [
  "거지력",
  "뒷구매",
  "잡담",
] as const;
export type RoomPostCategory = (typeof ROOM_POST_CATEGORIES)[number];

/** 뒷구매는 지출·예산·정산과 분리된 커뮤니티 전용 고해성사 기록이다. */
export type RoomSecretPurchase = {
  amount: number;
  occurredAt: string;
  expenseCategory: ExpenseCategory;
};

/** 방의 이야기. 작성 당시 진행 중인 주차는 기록용 도장으로만 남긴다. */
export type RoomPost = {
  id: string;
  clientRequestId: string;
  roomId: string;
  periodId?: string;
  kind: RoomPostKind;
  category?: RoomPostCategory;
  authorId: string;
  title?: string;
  body: string;
  /** 투표가 닫히는 첫 시각. 투표글이 아니면 없다. */
  pollClosesAt?: string;
  photoPath?: string;
  photoUri?: string;
  secretPurchase?: RoomSecretPurchase;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version?: number;
};

/** 멤버별 지출 읽음 상태. 상세를 열 때만 생성한다. */
export type ExpenseRead = {
  expenseId: string;
  userId: string;
  readAt: string;
};

/** 멤버별 게시글 읽음 상태. 상세를 열 때만 생성한다. */
export type RoomPostRead = {
  postId: string;
  userId: string;
  readAt: string;
};

/** 커뮤니티 글에 붙는 댓글. 답글은 하나의 댓글만 직접 인용한다. */
export type RoomPostComment = {
  id: string;
  clientRequestId: string;
  postId: string;
  authorId: string;
  body: string;
  replyToId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version?: number;
};

export const ROOM_POST_REACTION_EMOJIS = COMMENT_REACTION_EMOJIS;
export const QUICK_ROOM_POST_REACTION_EMOJIS = QUICK_COMMENT_REACTION_EMOJIS;
export type RoomPostReactionEmoji = CommentReactionEmoji;

export type RoomPostReaction = {
  postId: string;
  userId: string;
  emoji: RoomPostReactionEmoji;
  createdAt: string;
};

/** 투표글의 선택지. 표시 순서는 position으로 고정한다. */
export type RoomPostPollOption = {
  id: string;
  postId: string;
  body: string;
  position: number;
};

/** 방 멤버는 투표글마다 하나의 선택지만 고를 수 있으며 다시 고를 수 있다. */
export type RoomPostPollVote = {
  postId: string;
  optionId: string;
  userId: string;
  createdAt: string;
};

/** 앱 안 소식함에 표시하는 사용자별 이벤트. 일부 종류는 본문을 함께 저장한다. */
export type AppNotification = {
  id: string;
  userId: string;
  kind: string;
  actorId?: string;
  roomId?: string;
  periodId?: string;
  expenseId?: string;
  commentId?: string;
  postId?: string;
  route: string;
  body?: string;
  readAt?: string;
  createdAt: string;
};

export type WinnerNudgeGrant = {
  id: string;
  roomId: string;
  maxSendCount?: number;
  dailyLimit: number;
  sentCount: number;
  dailySentCount: number;
  dailySendOn?: string;
  lastSentAt?: string;
  expiresAt: string;
};

/** 지출에 붙은 예외 제안. 활성 멤버 전원 승인 시 정산에서 제외된다. */
export type ExpenseException = {
  expenseId: string;
  /** 짧은 사유 (기념일·야근 등). 최대 10자. */
  reason: string;
  requestedBy: string;
  requestedAt: string;
};

export type ExpenseExceptionResponseDecision = "APPROVED" | "HELD";

/** 예외에 대한 멤버 개별 응답. 제시자는 이 목록에 포함하지 않는다. */
export type ExpenseExceptionResponse = {
  expenseId: string;
  userId: string;
  decision: ExpenseExceptionResponseDecision;
  createdAt: string;
};

export type AppSnapshot = {
  currentUserId: string;
  profiles: Profile[];
  rooms: Room[];
  roomMembers: RoomMember[];
  periods: Period[];
  periodMembers: PeriodMember[];
  periodResults: PeriodResult[];
  memberStats: RoomMemberStats[];
  expenses: Expense[];
  expenseReads?: ExpenseRead[];
  comments: Comment[];
  commentMentions: CommentMention[];
  commentReactions: CommentReaction[];
  roomPosts: RoomPost[];
  roomPostComments: RoomPostComment[];
  roomPostReactions: RoomPostReaction[];
  roomPostReads?: RoomPostRead[];
  roomPostPollOptions: RoomPostPollOption[];
  roomPostPollVotes: RoomPostPollVote[];
  notifications: AppNotification[];
  winnerNudgeGrants?: WinnerNudgeGrant[];
  expenseExceptions: ExpenseException[];
  expenseExceptionResponses: ExpenseExceptionResponse[];
  processedRequestIds: string[];
};

export type InvitePreviewPeriod = {
  id: string;
  weekStart: LocalDate;
  weekEnd: LocalDate;
  selectedDayCount: number;
  validDayCount: number;
  holidayDates: LocalDate[];
};

export type InvitePreview = {
  code: string;
  roomId: string;
  name: string;
  baseAmount: number;
  capacity: number;
  memberCount: number;
  /** 진행 중(또는 대기 중)인 주차. 주말에는 비어 있을 수 있다. */
  currentPeriod?: InvitePreviewPeriod;
  joinedDate: LocalDate;
  eligibleDayCount: number;
  appliedLimit: number;
  isLateJoiner: boolean;
  /** false면 이번 주는 참여 없이 다음 주 월요일부터 시작한다. */
  participatesThisWeek: boolean;
  canJoin: boolean;
};

export type CreateRoomInput = {
  name: string;
  /** 주당 기준금액. */
  baseAmount: number;
  capacity: number;
  /** UUID reused when retrying the same create request. */
  clientRequestId?: string;
};

/** 방장이 바꿀 수 있는 방의 고정 설정. 기준금액은 생성 뒤 변경되지 않는다. */
export type UpdateRoomSettingsInput = {
  roomId: string;
  name: string;
  capacity: number;
};

export type SwitchRoomInput = {
  /** 지금 참여 중이라 떠나야 하는 방. */
  leaveRoomId: string;
  /** 방장이 떠날 때 방장을 넘겨받을 활성 멤버. 방장이 아니면 비운다. */
  successorId?: string;
  /** 새로 참여할 방의 참여 코드. */
  joinCode: string;
};

export type AddExpenseInput = Pick<
  Expense,
  "periodId" | "amount" | "pointAmount" | "category" | "memo" | "photoUri" | "occurredAt"
> & {
  clientRequestId: string;
  /** 예외 제안 사유(생성 시에만). 비우면 일반 지출. */
  exceptionReason?: string;
};

export type AddCommentInput = Pick<
  Comment,
  "expenseId" | "body" | "replyToId"
> & {
  clientRequestId: string;
  mentions?: readonly CommentMentionInput[];
};

export type AddRoomPostInput = {
  roomId: string;
  kind: RoomPostKind;
  /** 투표는 카테고리 없이 작성한다. */
  category?: RoomPostCategory;
  title: string;
  body: string;
  /** 기기에서 고른 사진 URI. 업로드 뒤 게시글에 연결하며 지출에는 기록하지 않는다. */
  photoUri?: string;
  secretPurchase?: RoomSecretPurchase;
  /** 투표글일 때만 2~4개의 선택지를 전달한다. */
  options?: readonly string[];
  clientRequestId: string;
};

/** 수정 시 기존 사진을 유지할지, 지울지, 새 사진으로 바꿀지 명시한다. */
export type RoomPostPhotoPatch =
  | { mode: "keep" }
  | { mode: "remove" }
  | { mode: "replace"; uri: string; clientRequestId: string };

export type UpdateRoomPostInput = {
  postId: string;
  /** 투표는 카테고리 없이 유지한다. */
  category?: RoomPostCategory;
  title: string;
  body: string;
  photo: RoomPostPhotoPatch;
  secretPurchase?: RoomSecretPurchase;
};

export type AddRoomPostCommentInput = {
  postId: string;
  body: string;
  replyToId?: string;
  clientRequestId: string;
};
