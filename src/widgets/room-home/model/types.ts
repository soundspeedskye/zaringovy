import type { MemberListItem } from "@/entities/member/ui/member-list";
import type { WeekDay } from "@/entities/room/ui/room-hero";
import type {
  Expense,
  Period,
  PeriodMember,
  Profile,
  Room,
  WinnerNudgeGrant,
} from "@/shared/api/types";
import type { PeriodPhase, PeriodTimeline } from "@/shared/model/types";

/** Everything the loaded home view renders, derived from the current room state. */
export type RoomHomeData = {
  activeRoom: Room;
  currentPeriod: Period;
  currentUser: Profile;
  currentMember: PeriodMember | undefined;
  appliedLimit: number;
  daysRemaining: number;
  mySpent: number;
  myPendingDelta: number;
  myPendingCount: number;
  phase: PeriodPhase;
  timeline: PeriodTimeline;
  weekMonthLabel: string;
  weekDays: WeekDay[];
  weekRangeLabel: string;
  memberRows: MemberListItem[];
  commentCounts: ReadonlyMap<string, number>;
  /** 홈 날짜칩의 빠른 확인 시트용. 최근 피드의 10건 제한을 적용하지 않는다. */
  feedExpenses: Expense[];
  recentExpenses: Expense[];
  profilesById: ReadonlyMap<string, Profile>;
  /** 아직 상세를 열지 않은 남의 지출 ID. 최근 피드·일별 시트의 NEW 표시에 쓴다. */
  unreadExpenseIds: ReadonlySet<string>;
  error: string | null;
  winnerNudgeGrant?: WinnerNudgeGrant;
};

/** Navigation and status callbacks shared across every home view state. */
export type RoomHomeActions = {
  addExpense: () => void;
  joinRoom: () => void;
  createRoom: () => void;
  clearError: () => void;
  retry: () => void;
  onOpenExpense: (expenseId: string, clientRequestId?: string) => void;
  onOpenMemberFeed: (userId: string) => void;
};

export type RoomHomeState =
  | { status: "loading" }
  | { status: "empty"; error: string | null }
  | { status: "ready"; data: RoomHomeData };
