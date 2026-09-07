import { memo, useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { WinnerNudgeGrant } from "@/shared/api/types";
import type { MemberListItem } from "@/entities/member/ui/member-list";
import { AnimalAvatar } from "@/shared/ui/animal-avatar";
import { WinnerCrownIcon } from "@/shared/ui/winner-crown-icon";
import { fonts, palette, radii, spacing } from "@/shared/config/design";
import { toSeoulLocalDate } from "@/shared/lib/domain/date-time";

export const WinnerNudgeSheet = memo(function WinnerNudgeSheet({
  grant, members, onClose, onSend, visible,
}: {
  grant: WinnerNudgeGrant;
  members: readonly MemberListItem[];
  onClose: () => void;
  onSend: (body: string) => Promise<void>;
  visible: boolean;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sentOnce, setSentOnce] = useState(false);
  const today = toSeoulLocalDate(Date.now());
  const sentToday = grant.dailySendOn === today ? grant.dailySentCount : 0;
  const remaining = Math.max(0, grant.dailyLimit - sentToday);
  const cooldownUntil = grant.lastSentAt ? new Date(new Date(grant.lastSentAt).getTime() + 30 * 60 * 1000) : null;
  const coolingDown = Boolean(cooldownUntil && cooldownUntil.getTime() > Date.now());
  const recipients = useMemo(() => members.filter((member) => !member.isCurrentUser), [members]);
  const canSend = body.trim().length > 0 && !sending && remaining > 0 && !coolingDown;
  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend(body.trim());
      setBody("");
      setSentOnce(true);
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.root}>
        <Pressable accessibilityLabel="잔소리 보내기 닫기" onPress={onClose} style={styles.backdrop} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.keyboard}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <View style={styles.titleRow}>
              <View style={styles.titleGroup}><WinnerCrownIcon size={31} /><Text accessibilityRole="header" style={styles.title}>잔소리 보내기</Text></View>
              <Pressable accessibilityLabel="닫기" onPress={onClose}><Text style={styles.close}>×</Text></Pressable>
            </View>
            <Text style={styles.subtitle}>지난 주차 1위를 축하합니다!{"\n"}보상으로 이번 주차 잔소리 발송권을 획득했습니다.</Text>
            <View style={styles.quota}><Text style={styles.quotaLabel}>오늘 보낼 수 있는 횟수</Text><Text style={styles.quotaValue}>{remaining} / {grant.dailyLimit}회 남음</Text></View>
            <View style={styles.recipientRow}><Text style={styles.recipientLabel}>받는 사람</Text><View style={styles.avatarStack}>{recipients.slice(0, 5).map((member, index) => <AnimalAvatar key={member.id} photoUri={member.avatarUri} size={38} style={index ? styles.avatarOverlap : undefined} value={member.avatar} />)}</View></View>
            <TextInput maxLength={80} multiline onChangeText={setBody} placeholder="이번 주도 영수증 잘 챙겨요!" placeholderTextColor={palette.muted} style={styles.input} value={body} />
            <Text style={styles.counter}>{body.length} / 80</Text>
            <Pressable accessibilityLabel="잔소리 보내기" disabled={!canSend} onPress={() => void submit()} style={[styles.submit, !canSend && styles.submitDisabled]}><Text style={styles.submitText}>{sending ? "보내는 중…" : "잔소리 보내기"}</Text></Pressable>
            {sentOnce || coolingDown ? <Text style={styles.cooldown}>30분 뒤에 다음 잔소리를 보낼 수 있습니다.</Text> : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" }, backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(42,38,32,0.24)" }, keyboard: { width: "100%" }, sheet: { padding: spacing.xl, paddingBottom: 34, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.line }, handle: { alignSelf: "center", width: 38, height: 5, marginBottom: spacing.lg, borderRadius: radii.pill, backgroundColor: palette.rule }, titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, titleGroup: { flexDirection: "row", alignItems: "center", gap: spacing.sm }, title: { color: palette.ink, fontFamily: fonts.handBold, fontSize: 25 }, close: { color: palette.muted, fontSize: 34, lineHeight: 34 }, subtitle: { marginTop: spacing.md, color: palette.muted, fontFamily: fonts.hand, fontSize: 15, lineHeight: 23 }, quota: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xl, paddingHorizontal: spacing.md, paddingVertical: 17, borderRadius: radii.xl, backgroundColor: "#FFF1CF" }, quotaLabel: { color: "#785610", fontFamily: fonts.handBold, fontSize: 15 }, quotaValue: { color: "#785610", fontFamily: fonts.number, fontSize: 15 }, recipientRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 70, marginTop: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radii.xl, borderColor: palette.line }, recipientLabel: { color: palette.muted, fontFamily: fonts.handBold, fontSize: 15 }, avatarStack: { flexDirection: "row", alignItems: "center" }, avatarOverlap: { marginLeft: -10, borderWidth: 2, borderColor: palette.paper }, input: { minHeight: 122, marginTop: spacing.md, padding: spacing.md, paddingBottom: 28, borderWidth: 1, borderRadius: radii.xl, borderColor: palette.line, color: palette.ink, fontFamily: fonts.hand, fontSize: 17, textAlignVertical: "top" }, counter: { marginTop: -24, marginRight: spacing.md, color: palette.muted, fontFamily: fonts.number, fontSize: 12, textAlign: "right" }, submit: { alignItems: "center", marginTop: spacing.xl, paddingVertical: 17, borderRadius: radii.xl, backgroundColor: palette.coral }, submitDisabled: { opacity: 0.45 }, submitText: { color: palette.paper, fontFamily: fonts.handBold, fontSize: 17 }, cooldown: { marginTop: spacing.md, color: palette.muted, fontFamily: fonts.hand, fontSize: 13, textAlign: "center" },
});
