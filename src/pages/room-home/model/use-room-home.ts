import { useRouter } from "expo-router";
import { useMemo } from "react";

import type { MemberListItem } from "@/entities/member/ui/member-list";
import {
  createPeriodTimeline,
  createWeekdayCalendarFromPeriod,
  getPeriodPhase,
} from "@/shared/lib/domain/period";
import type { WeekDay } from "@/entities/room/ui/room-hero";
import {
  compareExpenseFeedOrder,
  expenseOfficialAmount,
  expensePendingDelta,
  hasPendingExpenseProjection,
  isFeedVisibleExpense,
} from "@/shared/api/expense-sync";
import type { Expense } from "@/shared/api/types";
import {
  addLocalDays,
  startOfSeoulDate,
  toSeoulLocalDate,
} from "@/shared/lib/domain/date-time";
import { formatMonthDay, formatWon } from "@/shared/lib/format";
import { useDeadlineNow } from "@/shared/lib/use-deadline-now";
import { useCommentCounts } from "@/entities/expense/api/use-expense-comments";
import {
  usePeriodExpenses,
  useSettlementExcludedExpenseIds,
  useUnreadExpenseCountByUserId,
  useUnreadExpenseIds,
} from "@/entities/expense/api/use-expenses";
import { useProfiles } from "@/entities/member/api/use-members";
import {
  useMyPeriodJoinedAt,
  usePeriodMembers,
} from "@/entities/period/api/use-periods";
import { useCrownIds, useCurrentRoom, useWinnerNudgeGrant } from "@/shared/providers/app-data-hooks";
import { useAppStatus, useAppStatusActions } from "@/shared/providers/app-status-provider";
import { expenseDetailHref } from "@/shared/lib/expense-route";
import type { RoomHomeActions, RoomHomeState } from "@/widgets/room-home";

const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_EXPENSES: Expense[] = [];

export function useRoomHome(): { state: RoomHomeState; actions: RoomHomeActions } {
  const router = useRouter();
  const { activeRoom, currentPeriod, currentUser } = useCurrentRoom();
  const { error, loading } = useAppStatus();
  const { clearError, refresh } = useAppStatusActions();
  const members = usePeriodMembers(currentPeriod?.id);
  const periodExpenses = usePeriodExpenses(currentPeriod?.id);
  const expenses = useMemo(
    () => [...periodExpenses].sort(compareExpenseFeedOrder),
    [periodExpenses],
  );
  // 최근 피드는 이번 주차의 게시물만 보여 준다. 멤버 피드와 같은 노출 규칙.
  const currentPeriodFeedExpenses = useMemo(
    () => expenses.filter(isFeedVisibleExpense),
    [expenses],
  );
  const memberUserIds = useMemo(
    () => [
      ...members.map((member) => member.userId),
      ...currentPeriodFeedExpenses.map((expense) => expense.userId),
    ],
    [currentPeriodFeedExpenses, members],
  );
  const profilesById = useProfiles(memberUserIds);
  const commentCounts = useCommentCounts(currentPeriodFeedExpenses);
  const crownIds = useCrownIds(currentPeriod?.id);
  const winnerNudgeGrant = useWinnerNudgeGrant(activeRoom?.id);
  // 중도 합류자는 합류 전 지출까지 새 것으로 보지 않는다.
  const myPeriodJoinedAt = useMyPeriodJoinedAt(currentPeriod?.id, currentUser?.id);
  const unreadExpenseIds = useUnreadExpenseIds(
    currentPeriod?.id,
    currentUser?.id,
    myPeriodJoinedAt,
  );
  const unreadCountByUserId = useUnreadExpenseCountByUserId(
    currentPeriod?.id,
    unreadExpenseIds,
  );
  const excludedExpenseIds = useSettlementExcludedExpenseIds();
  const expensesByUserId = useMemo(() => {
    const grouped = new Map<string, Expense[]>();
    expenses.forEach((expense) => {
      const memberExpenses = grouped.get(expense.userId);
      if (memberExpenses) memberExpenses.push(expense);
      else grouped.set(expense.userId, [expense]);
    });
    return grouped;
  }, [expenses]);
  const timeline = useMemo(
    () => (currentPeriod ? createPeriodTimeline(currentPeriod.weekStart) : null),
    [currentPeriod],
  );
  const nextSeoulMidnight = startOfSeoulDate(
    addLocalDays(toSeoulLocalDate(Date.now()), 1),
  );
  const now = useDeadlineNow(
    timeline
      ? [
          timeline.S,
          timeline.E,
          timeline.C,
          timeline.F,
          nextSeoulMidnight,
        ]
      : [],
    Boolean(timeline),
  );
  const memberRows = useMemo<MemberListItem[]>(() => {
    if (!currentUser) return [];
    return members
      .filter((member) => member.status === "ACTIVE")
      .map((member) => {
        const profile = profilesById.get(member.userId);
        const memberExpenses =
          expensesByUserId.get(member.userId) ?? EMPTY_EXPENSES;
        const spent = memberExpenses.reduce(
          (sum, expense) =>
            excludedExpenseIds.has(expense.id)
              ? sum
              : sum + expenseOfficialAmount(expense),
          0,
        );
        const latestCreatedExpense = memberExpenses[0];
        return {
          id: member.userId,
          nickname: profile?.nickname ?? "알 수 없음",
          avatar: profile?.avatar ?? "",
          avatarUri: profile?.avatarUri,
          detail: latestCreatedExpense
            ? `${latestCreatedExpense.category} ${formatWon(latestCreatedExpense.amount)}`
            : member.isLateJoiner
              ? `${member.joinedDate} 합류`
              : "아직 지출 없음",
          remaining: member.appliedLimit - spent,
          isCrowned: crownIds.includes(member.userId),
          isLateJoiner: member.isLateJoiner,
          isCurrentUser: member.userId === currentUser.id,
          unreadExpenseCount: unreadCountByUserId.get(member.userId) ?? 0,
        };
      });
  }, [
    crownIds,
    currentUser,
    excludedExpenseIds,
    expensesByUserId,
    members,
    profilesById,
    unreadCountByUserId,
  ]);

  const actions = useMemo<RoomHomeActions>(
    () => ({
      addExpense: () => router.push("/expense/new"),
      joinRoom: () => router.push("/room/join"),
      createRoom: () => router.push("/room/create"),
      clearError,
      retry: () => void refresh(),
      onOpenExpense: (expenseId: string, clientRequestId?: string) =>
        router.push(expenseDetailHref(expenseId, clientRequestId)),
      onOpenMemberFeed: (userId: string) => router.push(`/room/member/${userId}`),
    }),
    [clearError, refresh, router],
  );

  const state = useMemo<RoomHomeState>(() => {
    if (loading) return { status: "loading" };
    if (!activeRoom || !currentPeriod || !currentUser || !timeline) {
      return { status: "empty", error };
    }

    const phase = getPeriodPhase(timeline, now);
    const currentMember = members.find(
      (member) => member.userId === currentUser.id,
    );
    const myExpenses = expenses.filter(
      (expense) => expense.userId === currentUser.id,
    );
    const mySpent = myExpenses.reduce(
      (sum, expense) =>
        excludedExpenseIds.has(expense.id) ? sum : sum + expenseOfficialAmount(expense),
      0,
    );
    const myPendingDelta = myExpenses.reduce(
      (sum, expense) => sum + expensePendingDelta(expense),
      0,
    );
    const myPendingCount = myExpenses.filter((expense) =>
      hasPendingExpenseProjection(expense),
    ).length;
    const appliedLimit = currentMember?.appliedLimit ?? activeRoom.baseAmount;
    const today = toSeoulLocalDate(now);
    const daysRemaining = Math.max(
      0,
      Math.round(
        (startOfSeoulDate(currentPeriod.weekEnd) - startOfSeoulDate(today)) /
          DAY_MS,
      ),
    );
    // 참여 시작일: 중도 합류면 합류일부터, 전체 참여면 주 시작일부터. 비멤버면 참여 없음.
    const participationStart = currentMember
      ? currentMember.isLateJoiner
        ? currentMember.joinedDate
        : currentPeriod.weekStart
      : null;
    const weekMonthLabel = `${Number(currentPeriod.weekStart.slice(5, 7))}월`;
    const weekDays: WeekDay[] = createWeekdayCalendarFromPeriod(
      currentPeriod,
    ).days.map((periodDay) => ({
      date: periodDay.date,
      day: Number(periodDay.date.slice(8, 10)),
      participating:
        participationStart != null &&
        periodDay.date >= participationStart &&
        !periodDay.isHoliday,
      isHoliday: periodDay.isHoliday,
      isToday: periodDay.date === today,
    }));
    const weekRangeLabel = currentMember
      ? currentMember.isLateJoiner
        ? `${formatMonthDay(currentMember.joinedDate)}부터 ${formatMonthDay(currentPeriod.weekEnd)}까지 참여`
        : "이번 주 전체 참여"
      : "다음 주부터 참여";

    return {
      status: "ready",
      data: {
        activeRoom,
        currentPeriod,
        currentUser,
        currentMember,
        appliedLimit,
        daysRemaining,
        mySpent,
        myPendingDelta,
        myPendingCount,
        phase,
        timeline,
        weekMonthLabel,
        weekDays,
        weekRangeLabel,
        memberRows,
        commentCounts,
        feedExpenses: currentPeriodFeedExpenses,
        recentExpenses: currentPeriodFeedExpenses.slice(0, 10),
        profilesById,
        unreadExpenseIds,
        error,
        winnerNudgeGrant: winnerNudgeGrant && new Date(winnerNudgeGrant.expiresAt).getTime() > now
          && (winnerNudgeGrant.maxSendCount === undefined || winnerNudgeGrant.sentCount < winnerNudgeGrant.maxSendCount)
          ? winnerNudgeGrant
          : undefined,
      },
    };
  }, [
    activeRoom,
    commentCounts,
    currentPeriod,
    currentUser,
    error,
    excludedExpenseIds,
    expenses,
    loading,
    memberRows,
    members,
    now,
    profilesById,
    timeline,
    currentPeriodFeedExpenses,
    unreadExpenseIds,
    winnerNudgeGrant,
  ]);

  return { state, actions };
}
