import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { AnimalAvatar } from "@/shared/ui/animal-avatar";
import { WinnerCrownIcon } from "@/shared/ui/winner-crown-icon";
import {
  fonts,
  palette,
  radii,
  shadow,
  spacing,
  tabularNums,
} from "@/shared/config/design";
import { formatWon } from "@/shared/lib/format";

// 그 주 평일 한 칸. participating = 참여 기간(합류일~주말) 안이면서 공휴일이 아닌 날.
export type WeekDay = {
  date: string;
  day: number;
  participating: boolean;
  isHoliday: boolean;
  isToday: boolean;
};

type RoomHeroProps = {
  title: string;
  weekIndex: number;
  daysRemaining: number;
  appliedLimit: number;
  spent: number;
  pendingDelta?: number;
  pendingCount?: number;
  weekMonthLabel: string;
  weekDays: WeekDay[];
  weekRangeLabel: string;
  participants: readonly {
    id: string;
    avatar: string;
    avatarUri?: string;
  }[];
  onPressSettings?: () => void;
  /** 유효한 날짜를 누르면, 화면을 벗어나지 않고 그날의 지출 요약을 연다. */
  onPressWeekDay?: (date: string) => void;
  onPressWinnerNudge?: () => void;
};

const ringSize = 132;
const ringStroke = 20;
const radius = (ringSize - ringStroke) / 2;
const circumference = 2 * Math.PI * radius;

export function RoomHero({
  title,
  weekIndex,
  daysRemaining,
  appliedLimit,
  spent,
  pendingDelta = 0,
  pendingCount = 0,
  weekMonthLabel,
  weekDays,
  weekRangeLabel,
  participants,
  onPressSettings,
  onPressWeekDay,
  onPressWinnerNudge,
}: RoomHeroProps) {
  const safeLimit = Math.max(appliedLimit, 1);
  const hasPending = pendingDelta !== 0 || pendingCount > 0;
  const progress = Math.min(Math.max(spent / safeLimit, 0), 1);
  const remaining = appliedLimit - spent;

  return (
    <View
      accessible={!onPressSettings && !onPressWeekDay}
      accessibilityLabel={`${title} ${weekIndex}주차, ${weekRangeLabel}, 적용한도 ${formatWon(appliedLimit)}, 함께하는 멤버 ${participants.length}명, 서버 공식 합계 기준 ${remaining < 0 ? `${formatWon(Math.abs(remaining))} 초과` : `${formatWon(remaining)} 남음`}${hasPending ? `, ${pendingDelta === 0 ? "금액 외 변경" : `동기화 대기 반영분 ${formatSignedWon(pendingDelta)}`}는 공식 합계 제외` : ""}`}
      style={styles.container}
    >
      <View style={styles.header}>
        <Text style={styles.eyebrow}>평일 챌린지 · {weekIndex}주차</Text>
        <Text style={styles.eyebrow}>
          {daysRemaining <= 0 ? "오늘 종료" : `D-${daysRemaining}`} | {weekMonthLabel}
        </Text>
      </View>
      <View style={[styles.titleRow, onPressWinnerNudge && styles.titleRowWithNudge]}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {onPressSettings ? (
          <Pressable
            accessibilityLabel="방 설정"
            accessibilityRole="button"
            hitSlop={6}
            onPress={onPressSettings}
            style={({ pressed }) => [
              styles.settingsButton,
              pressed && styles.settingsButtonPressed,
            ]}
          >
            <MaterialCommunityIcons
              color={palette.cream}
              name="cog-outline"
              size={20}
            />
          </Pressable>
        ) : null}
      </View>
      {onPressWinnerNudge ? (
        <View style={styles.winnerNudgeRow}>
          <View style={styles.winnerNudgeLabel}><WinnerCrownIcon size={22} /><Text style={styles.winnerNudgeText}>지난 주차 1위!</Text></View>
          <Pressable accessibilityLabel="잔소리 보내기" accessibilityRole="button" onPress={onPressWinnerNudge} style={styles.winnerNudgeButton}><Text style={styles.winnerNudgeButtonText}>잔소리 ›</Text></Pressable>
        </View>
      ) : null}
      <View style={styles.summary}>
        <View style={styles.ringWrap}>
          <Svg
            accessibilityLabel={`예산 사용률 ${Math.round(progress * 100)}퍼센트`}
            height={ringSize}
            width={ringSize}
          >
            <Circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              fill="transparent"
              r={radius}
              stroke={palette.greenSoft}
              strokeWidth={ringStroke}
            />
            <Circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              fill="transparent"
              r={radius}
              stroke={spent > appliedLimit ? palette.coral : palette.yellow}
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={circumference * (1 - progress)}
              strokeLinecap="butt"
              strokeWidth={ringStroke}
              transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
            />
          </Svg>
          <View pointerEvents="none" style={styles.ringLabel}>
            <Text numberOfLines={1} style={styles.remainingValue}>
              {formatWon(Math.abs(remaining), false)}
            </Text>
            <Text style={styles.remainingLabel}>
              {remaining < 0 ? "초과" : "남음"}
            </Text>
          </View>
        </View>
        <View style={styles.limitCopy}>
          <Text
            adjustsFontSizeToFit
            numberOfLines={1}
            style={styles.limitValue}
          >
            {formatWon(appliedLimit)}
          </Text>
          <View accessibilityLabel={weekRangeLabel} style={styles.weekStrip}>
            {weekDays.map((weekDay) => {
              const canOpenDay = Boolean(
                onPressWeekDay && weekDay.participating && !weekDay.isHoliday,
              );
              const cell = (
                <View
                  style={[
                    styles.weekCell,
                    weekDay.participating && styles.weekCellIn,
                    weekDay.isToday && styles.weekCellToday,
                  ]}
                >
                  <Text
                    style={[
                      styles.weekDayText,
                      weekDay.participating && styles.weekDayIn,
                      weekDay.isToday && styles.weekDayToday,
                      weekDay.isHoliday && styles.weekDayHoliday,
                    ]}
                  >
                    {weekDay.day}
                  </Text>
                </View>
              );

              return canOpenDay ? (
                <Pressable
                  accessibilityHint="이 날짜의 지출 기록을 빠르게 확인해요"
                  accessibilityLabel={`${weekDay.day}일 지출 기록 보기`}
                  accessibilityRole="button"
                  key={weekDay.date}
                  onPress={() => onPressWeekDay?.(weekDay.date)}
                  style={({ pressed }) => [styles.weekDayButton, pressed && styles.weekDayButtonPressed]}
                >
                  {cell}
                </Pressable>
              ) : (
                <View key={weekDay.date} style={styles.weekDayButton}>
                  {cell}
                </View>
              );
            })}
          </View>
          {hasPending ? (
            <Text style={styles.pendingText}>
              임시 합계 {formatWon(spent + pendingDelta)} ·{" "}
              {pendingDelta === 0
                ? "금액 외 변경 대기"
                : `대기 반영 ${formatSignedWon(pendingDelta)}`}
            </Text>
          ) : null}
        </View>
      </View>
      <View
        accessibilityLabel={`함께하는 멤버 ${participants.length}명`}
        style={styles.avatarStack}
      >
        {participants.slice(0, 5).map((participant, index) => (
          <AnimalAvatar
            key={participant.id}
            photoUri={participant.avatarUri}
            size={26}
            style={[styles.memberAvatar, index > 0 && styles.memberAvatarOverlap]}
            value={participant.avatar}
          />
        ))}
        {participants.length > 5 ? (
          <View style={[styles.moreMembers, styles.memberAvatarOverlap]}>
            <Text style={styles.moreMembersText}>+{participants.length - 5}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function formatSignedWon(value: number): string {
  return `${value > 0 ? "+" : "-"}${formatWon(Math.abs(value))}`;
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: 42,
    borderRadius: radii.xl,
    backgroundColor: palette.green,
    ...shadow,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  eyebrow: {
    color: palette.cream,
    fontFamily: fonts.hand,
    fontSize: 13,
    letterSpacing: 0.2,
    fontWeight: "500",
  },
  title: {
    flex: 1,
    color: palette.cream,
    fontFamily: fonts.hand,
    fontSize: 26,
    fontWeight: "600",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: 12,
    marginBottom: 22,
  },
  titleRowWithNudge: { marginBottom: spacing.sm },
  winnerNudgeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.lg },
  winnerNudgeLabel: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  winnerNudgeText: { color: palette.cream, fontFamily: fonts.handBold, fontSize: 14 },
  winnerNudgeButton: { paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: radii.pill, backgroundColor: "rgba(255,255,255,0.14)", borderWidth: 1, borderColor: "rgba(253,246,227,0.32)" },
  winnerNudgeButtonText: { color: palette.cream, fontFamily: fonts.handBold, fontSize: 13 },
  summary: { flexDirection: "row", alignItems: "center", gap: spacing.xl },
  ringWrap: {
    width: ringSize,
    height: ringSize,
    alignItems: "center",
    justifyContent: "center",
  },
  ringLabel: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    inset: 0,
  },
  remainingValue: {
    color: palette.cream,
    fontFamily: fonts.number,
    fontSize: 16,
    fontWeight: "600",
    maxWidth: 86,
    ...tabularNums,
  },
  remainingLabel: {
    color: palette.cream,
    fontFamily: fonts.hand,
    fontSize: 13,
    marginTop: 2,
  },
  limitCopy: { flex: 1, minWidth: 0 },
  weekStrip: { flexDirection: "row", gap: 4, marginTop: spacing.sm },
  weekDayButton: { flex: 1, borderRadius: radii.md },
  weekDayButtonPressed: { opacity: 0.78, transform: [{ scale: 0.96 }] },
  weekCell: {
    width: "100%",
    alignItems: "center",
    paddingVertical: 6,
    borderRadius: radii.md,
  },
  weekCellIn: { backgroundColor: "rgba(255,255,255,0.13)" },
  weekCellToday: { backgroundColor: "rgba(255,255,255,0.22)" },
  weekDayText: {
    color: "rgba(253,246,227,0.42)",
    fontFamily: fonts.number,
    fontSize: 13,
    ...tabularNums,
  },
  weekDayIn: { color: palette.cream },
  weekDayToday: { color: palette.white, fontWeight: "700", fontSize: 16 },
  weekDayHoliday: { color: palette.coral },
  limitValue: {
    color: palette.cream,
    fontFamily: fonts.number,
    fontSize: 28,
    fontWeight: "700",
    textAlign: "right",
    ...tabularNums,
  },
  avatarStack: {
    position: "absolute",
    right: spacing.xl,
    bottom: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
  },
  memberAvatar: {
    borderWidth: 1.5,
    borderColor: palette.green,
  },
  memberAvatarOverlap: { marginLeft: -7 },
  moreMembers: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: palette.green,
    backgroundColor: palette.cream,
  },
  moreMembersText: {
    color: palette.green,
    fontFamily: fonts.number,
    fontSize: 9,
    fontWeight: "700",
    ...tabularNums,
  },
  settingsButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(253,246,227,0.32)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  settingsButtonPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  pendingText: {
    color: palette.cream,
    fontFamily: fonts.hand,
    fontSize: 11,
    marginTop: spacing.sm,
    ...tabularNums,
  },
});
