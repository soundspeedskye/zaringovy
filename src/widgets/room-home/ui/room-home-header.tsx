import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useRouter } from "expo-router";
import { memo, useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ExceptionApprovalInbox } from "@/features/exception-approval";
import { RecentExpenseCarousel } from "@/entities/expense/ui/recent-expense-carousel";
import { DailyExpensePeekSheet } from "@/entities/expense/ui/daily-expense-peek-sheet";
import { RoomHero } from "@/entities/room/ui/room-hero";
import { ErrorBanner } from "@/shared/ui/error-banner";
import { NoticeBanner } from "@/shared/ui/notice-banner";
import {
  fonts,
  palette,
  radii,
  shadow,
  spacing,
  tabularNums,
} from "@/shared/config/design";
import { isExpenseMutationPhase } from "@/shared/lib/domain/permissions";
import type { PeriodPhase } from "@/shared/model/types";
import type { RoomHomeActions, RoomHomeData } from "../model/types";
import {
  useUnreadNotificationCount,
} from "@/entities/notification/api/use-notifications";
import { useAppDialog } from "@/shared/providers/app-dialog-provider";
import { formatDateLabel } from "@/shared/lib/format";
import { WinnerNudgeSheet } from "@/features/winner-nudge/ui/winner-nudge-sheet";
import { useAppActions } from "@/shared/providers/app-actions-provider";

export const RoomHomeHeader = memo(function RoomHomeHeader({
  actions,
  data,
}: {
  actions: RoomHomeActions;
  data: RoomHomeData;
}) {
  const router = useRouter();
  const { showDialog } = useAppDialog();
  const { sendWinnerNudge } = useAppActions();
  const unreadNotificationCount = useUnreadNotificationCount();
  const {
    activeRoom,
    appliedLimit,
    commentCounts,
    currentMember,
    currentPeriod,
    currentUser,
    daysRemaining,
    error,
    feedExpenses,
    memberRows,
    myPendingCount,
    myPendingDelta,
    mySpent,
    phase,
    profilesById,
    recentExpenses,
    unreadExpenseIds,
    timeline,
    weekMonthLabel,
    weekDays,
    weekRangeLabel,
    winnerNudgeGrant,
  } = data;
  const {
    addExpense,
    clearError,
    createRoom,
    joinRoom,
    onOpenExpense,
    onOpenMemberFeed,
  } = actions;
  const isRoomOwner = activeRoom.ownerId === currentUser.id;
  const [peekDate, setPeekDate] = useState<string | null>(null);
  const [winnerNudgeOpen, setWinnerNudgeOpen] = useState(false);
  // 시트가 히어로 카드를 가리지 않도록, 열 때 카드 아래 끝의 화면 좌표를 재서 넘긴다.
  // 날짜칩이 카드 안에 있으니 이 시점의 카드는 항상 화면에 있다.
  const [peekTopOffset, setPeekTopOffset] = useState<number | null>(null);
  const heroRef = useRef<View>(null);
  const openDailyExpensePeek = useCallback((date: string) => {
    const hero = heroRef.current;
    if (!hero) {
      setPeekTopOffset(null);
      setPeekDate(date);
      return;
    }
    // 높이가 확정된 뒤에 열어야 열림 애니메이션이 도중에 다시 시작되지 않는다.
    hero.measureInWindow((_x, y, _width, height) => {
      setPeekTopOffset(y + height);
      setPeekDate(date);
    });
  }, []);
  const closeDailyExpensePeek = useCallback(() => setPeekDate(null), []);
  // 제목·본문 없이 항목만 보여준다. 다이얼로그가 떴다는 것 자체가 "고르세요"라는 뜻이다.
  const openRoomActions = () => {
    showDialog(undefined, undefined, [
      { text: "취소", style: "cancel" },
      { text: "참여 코드로 참여", onPress: joinRoom },
      { text: "새 챌린지 만들기", onPress: createRoom },
    ]);
  };
  return (
    <>
      <ExceptionApprovalInbox />
      <View style={styles.topActions}>
        <Text style={styles.greeting}>
          {currentUser.nickname}님, 이번주도 모아볼까요?
        </Text>
        <View style={styles.actionButtons}>
          <Pressable
            accessibilityLabel={
              unreadNotificationCount
                ? `소식함, 읽지 않은 소식 ${unreadNotificationCount}개`
                : "소식함"
            }
            onPress={() => router.push("/notifications")}
            style={styles.circleButton}
          >
            <MaterialCommunityIcons
              color={palette.green}
              name={unreadNotificationCount ? "bell" : "bell-outline"}
              size={21}
            />
            {unreadNotificationCount ? (
              <View style={styles.notificationBadge}>
                <Text style={styles.notificationBadgeText}>
                  {unreadNotificationCount > 9 ? "9+" : unreadNotificationCount}
                </Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable
            accessibilityLabel="방 만들기 또는 코드로 참여"
            onPress={openRoomActions}
            style={styles.circleButton}
          >
            <MaterialCommunityIcons
              color={palette.green}
              name="plus"
              size={23}
            />
          </Pressable>
        </View>
      </View>

      <ErrorBanner error={error} onDismiss={clearError} />

      <View collapsable={false} ref={heroRef}>
        <RoomHero
          appliedLimit={appliedLimit}
          daysRemaining={daysRemaining}
          pendingDelta={myPendingDelta}
          pendingCount={myPendingCount}
          spent={mySpent}
          title={activeRoom.name}
          weekDays={weekDays}
          weekIndex={currentPeriod.weekIndex}
          weekMonthLabel={weekMonthLabel}
          weekRangeLabel={weekRangeLabel}
          participants={memberRows}
          onPressWinnerNudge={winnerNudgeGrant ? () => setWinnerNudgeOpen(true) : undefined}
          onPressWeekDay={openDailyExpensePeek}
          onPressSettings={
            isRoomOwner ? () => router.push("/room/edit") : undefined
          }
        />
      </View>

      <DailyExpensePeekSheet
        date={peekDate}
        expenses={feedExpenses}
        onClose={closeDailyExpensePeek}
        onSelectExpense={onOpenExpense}
        profilesById={profilesById}
        topOffset={peekTopOffset}
        unreadExpenseIds={unreadExpenseIds}
      />
      {winnerNudgeGrant ? <WinnerNudgeSheet grant={winnerNudgeGrant} members={memberRows} onClose={() => setWinnerNudgeOpen(false)} onSend={(body) => sendWinnerNudge({ roomId: activeRoom.id, body })} visible={winnerNudgeOpen} /> : null}

      <RecentExpenseCarousel
        commentCounts={commentCounts}
        expenses={recentExpenses}
        onOpenExpense={onOpenExpense}
        onOpenMemberFeed={onOpenMemberFeed}
        profilesById={profilesById}
        unreadExpenseIds={unreadExpenseIds}
      />

      <View style={styles.inviteSection}>
        <View
          accessible
          accessibilityLabel={`참여 코드 ${activeRoom.inviteCode}, 현재 ${memberRows.length}명, 최대 ${activeRoom.capacity}명`}
          style={styles.codePill}
        >
          <MaterialCommunityIcons
            color={palette.green}
            name="link-variant"
            size={16}
          />
          <Text selectable style={styles.code}>
            {activeRoom.inviteCode}
          </Text>
          <View style={styles.codeDivider} />
          <Text style={styles.capacity}>
            {memberRows.length}/{activeRoom.capacity}명
          </Text>
        </View>
        {!currentPeriod.isRestWeek &&
        currentMember &&
        isExpenseMutationPhase(phase) ? (
          <Pressable
            accessibilityLabel="지출 등록"
            accessibilityRole="button"
            onPress={addExpense}
            style={styles.addExpenseButton}
          >
            <MaterialCommunityIcons
              color={palette.cream}
              name="camera-plus-outline"
              size={18}
            />
            <Text style={styles.addButtonText}>지출 등록</Text>
          </Pressable>
        ) : null}
      </View>

      {currentPeriod.isRestWeek ? (
        <NoticeBanner icon="palm-tree" style={styles.phaseBanner}>
          이번 주는 평일이 모두 공휴일이라 쉬는 주예요. 누적 기록에는 포함되지
          않아요.
        </NoticeBanner>
      ) : (
        <PhaseBanner phase={phase} timeline={timeline} />
      )}
    </>
  );
});

function PhaseBanner({
  phase,
  timeline,
}: {
  phase: PeriodPhase;
  timeline: { E: number; C: number; F: number };
}) {
  if (phase === "ACTIVE" || phase === "WAITING") return null;
  const copy =
    phase === "ADJUSTMENT"
      ? `보정 중 · ${formatDateLabel(new Date(timeline.C))}까지 기간 내 지출을 수정할 수 있어요.`
      : phase === "SETTLEMENT"
        ? `정산 중 · 지출이 잠겼어요. ${formatDateLabel(new Date(timeline.F))}에 결과가 확정돼요.`
        : "정산이 끝난 주차예요. 기록은 읽기 전용으로 보관됩니다.";
  return (
    <NoticeBanner icon="clock-outline" style={styles.phaseBanner}>
      {copy}
    </NoticeBanner>
  );
}

const styles = StyleSheet.create({
  topActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  greeting: {
    color: palette.ink,
    fontFamily: fonts.hand,
    fontSize: 19,
    fontWeight: "600",
    marginTop: 3,
  },
  actionButtons: { flexDirection: "row", gap: spacing.sm },
  circleButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  notificationBadge: {
    position: "absolute",
    top: -1,
    right: -3,
    minWidth: 17,
    height: 17,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
    borderRadius: 9,
    backgroundColor: palette.coral,
    borderWidth: 1,
    borderColor: palette.cream,
  },
  notificationBadgeText: {
    color: palette.cream,
    fontFamily: fonts.number,
    fontSize: 9,
    fontWeight: "800",
    ...tabularNums,
  },
  inviteSection: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(52,49,40,0.12)",
  },
  codePill: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.paper,
  },
  code: {
    color: palette.green,
    fontFamily: fonts.number,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.2,
    ...tabularNums,
  },
  codeDivider: {
    width: StyleSheet.hairlineWidth,
    height: 16,
    backgroundColor: "rgba(52,49,40,0.18)",
  },
  capacity: {
    color: palette.muted,
    fontFamily: fonts.hand,
    fontSize: 10,
    fontWeight: "600",
    ...tabularNums,
  },
  phaseBanner: {
    marginTop: spacing.lg,
  },
  addExpenseButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: palette.green,
    ...shadow,
  },
  addButtonText: {
    color: palette.cream,
    fontFamily: fonts.handBold,
    fontSize: 13,
    fontWeight: "700",
  },
});
