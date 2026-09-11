import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AnimalAvatar } from '@/shared/ui/animal-avatar';
import { UnreadDot } from '@/shared/ui/unread-dot';
import { WinnerCrownIcon } from '@/shared/ui/winner-crown-icon';
import { fonts, palette, spacing, tabularNums } from '@/shared/config/design';
import { formatWon } from '@/shared/lib/format';

export type MemberListItem = {
  id: string;
  nickname: string;
  avatar: string;
  avatarUri?: string;
  detail: string;
  remaining: number;
  isCrowned: boolean;
  isLateJoiner?: boolean;
  isCurrentUser?: boolean;
  /** 이 멤버가 올린 지출 중 내가 아직 열어 보지 않은 건수. */
  unreadExpenseCount?: number;
};

// 홈은 갱신마다 data 객체를 새로 만들어 내려보낸다. members 배열이 그대로면
// 멤버 줄을 다시 그리지 않도록 막는다.
export const MemberList = memo(function MemberList({
  members,
  onPressAvatar,
}: {
  members: MemberListItem[];
  onPressAvatar?: (userId: string) => void;
}) {
  return (
    <View accessibilityLabel={`함께하는 멤버 ${members.length}명`} accessibilityRole="list">
      <View style={styles.header}>
        <Text style={styles.heading}>함께하는 멤버</Text>
        <Text accessibilityLabel={`현재 멤버 ${members.length}명`} style={styles.count}>{members.length}명</Text>
      </View>
      {members.map((member, index) => {
        const displayName = member.isCurrentUser ? '나' : member.nickname;
        const balanceLabel = member.remaining < 0
          ? `${formatWon(Math.abs(member.remaining))} 초과`
          : `${formatWon(member.remaining)} 남음`;
        return (
          <View
            accessible
            accessibilityLabel={`${member.isCrowned ? '현재 1위, ' : ''}${displayName}, ${member.detail}, ${balanceLabel}${member.unreadExpenseCount ? `, 읽지 않은 지출 ${member.unreadExpenseCount}건` : ''}`}
            key={member.id}
            style={[
              styles.row,
              member.isCurrentUser && styles.currentUserRow,
              index === members.length - 1 && styles.lastRow,
            ]}>
            {onPressAvatar ? (
              <Pressable
                accessibilityLabel={`${displayName}님의 피드 보기`}
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => onPressAvatar(member.id)}
                style={styles.avatarSlot}
              >
                <AnimalAvatar photoUri={member.avatarUri} value={member.avatar} size={46} style={styles.avatar} />
                <UnreadDot count={member.unreadExpenseCount ?? 0} />
              </Pressable>
            ) : (
              <View style={styles.avatarSlot}>
                <AnimalAvatar photoUri={member.avatarUri} value={member.avatar} size={46} style={styles.avatar} />
                <UnreadDot count={member.unreadExpenseCount ?? 0} />
              </View>
            )}
            <View style={styles.copy}>
              <View style={styles.nameRow}>
                {member.isCrowned ? <WinnerCrownIcon size={18} /> : null}
                <Text numberOfLines={1} style={styles.name}>
                  {member.isCurrentUser ? '나' : member.nickname}
                </Text>
                {member.isLateJoiner ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>중도 합류</Text>
                  </View>
                ) : null}
              </View>
              <Text numberOfLines={1} style={styles.detail}>
                {member.detail}
              </Text>
            </View>
            <View style={styles.amount}>
              <Text style={[styles.amountValue, member.remaining < 0 && styles.amountValueOver]}>
                {formatWon(Math.abs(member.remaining), false)}
              </Text>
              <Text style={styles.amountLabel}>{member.remaining < 0 ? '초과' : '남음'}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  header: {
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heading: { color: palette.ink, fontFamily: fonts.handBold, fontSize: 19, fontWeight: '700', letterSpacing: -0.2 },
  count: { color: palette.muted, fontFamily: fonts.hand, fontSize: 13 },
  row: {
    minHeight: 80,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(52,49,40,0.12)',
  },
  currentUserRow: {
    backgroundColor: 'rgba(47,113,93,0.055)',
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 16,
  },
  lastRow: { borderBottomWidth: 0 },
  avatarSlot: { position: 'relative' },
  avatar: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.88)',
  },
  copy: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: palette.ink, fontFamily: fonts.handBold, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(233,135,98,0.20)',
    backgroundColor: 'rgba(233,135,98,0.10)',
  },
  badgeText: { color: palette.danger, fontSize: 10, fontWeight: '700' },
  detail: { color: palette.muted, fontFamily: fonts.hand, fontSize: 12, marginTop: 5 },
  amount: { minWidth: 72, alignItems: 'flex-end' },
  amountValue: { color: palette.green, fontFamily: fonts.number, fontSize: 19, fontWeight: '600', ...tabularNums },
  amountValueOver: { color: palette.danger },
  amountLabel: { color: palette.muted, fontFamily: fonts.hand, fontSize: 10, marginTop: 2 },
});
