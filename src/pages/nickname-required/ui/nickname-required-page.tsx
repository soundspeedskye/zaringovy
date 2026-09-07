import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";

import { Field } from "@/shared/ui/field";
import { ModalFormScreen } from "@/shared/ui/modal-form-screen";
import { NoticeBanner } from "@/shared/ui/notice-banner";
import { PrimaryButton } from "@/shared/ui/primary-button";
import { fonts, palette, spacing } from "@/shared/config/design";
import { useSubmit } from "@/shared/lib/use-submit";
import { useAppActions } from "@/shared/providers/app-actions-provider";
import { useAppDialog } from "@/shared/providers/app-dialog-provider";
import { useCurrentUser } from "@/entities/member/api/use-members";
import { useActiveRoom } from "@/entities/room/api/use-rooms";

/**
 * 먼저 참여한 같은 닉네임의 멤버가 있어 방 활동이 막힌 사용자가 서는 화면.
 *
 * 프로필 편집과 분리한 이유는 두 가지다. 여기서는 아바타·사진이 아니라 닉네임
 * 하나만 정하면 되고, 이 화면은 사용자가 열고 닫는 화면이 아니라 통과해야 하는
 * 관문이다. 뒤로가기는 방 화면으로 가는 문이 아니라 "방 나가기" 확인으로 이어진다.
 *
 * 화면을 벗어나는 판단 자체는 여기서 하지 않는다. 서버가 표시를 지우면 스냅샷이
 * 바뀌고, 앱 루트의 가드가 원래 자리로 돌려보낸다.
 */
export function NicknameRequiredPage() {
  const router = useRouter();
  const activeRoom = useActiveRoom();
  const currentUser = useCurrentUser();
  const { leaveRoom, updateNickname } = useAppActions();
  const { showDialog } = useAppDialog();
  const [nickname, setNickname] = useState(currentUser?.nickname ?? "");
  const { error, setError, submit, submitting } = useSubmit(
    "닉네임을 변경하지 못했어요.",
  );

  const leave = useCallback(
    () =>
      submit(async () => {
        if (!activeRoom) return;
        await leaveRoom(activeRoom.id);
        router.replace("/");
      }, "방을 나가지 못했어요."),
    [activeRoom, leaveRoom, router, submit],
  );

  // 헤더 뒤로가기와 안드로이드 뒤로가기가 같은 곳으로 간다. 이 화면을 지나치지
  // 않고 방으로 돌아갈 길은 없으므로, 뒤로가기는 "그만두기"가 아니라 "나가기"다.
  const confirmLeave = useCallback(() => {
    if (submitting) return;
    showDialog(
      "방에서 나갈까요?",
      "닉네임을 변경하지 않고 방에서 나갑니다. 나간 방에는 다시 참여할 수 없습니다.",
      [
        { text: "방 나가기", style: "destructive", onPress: () => void leave() },
        { text: "계속 변경하기", style: "cancel" },
      ],
    );
  }, [leave, showDialog, submitting]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        confirmLeave();
        return true;
      },
    );
    return () => subscription.remove();
  }, [confirmLeave]);

  const save = () =>
    submit(async () => {
      const nextNickname = nickname.trim();
      if (nextNickname.length < 2 || nextNickname.length > 20) {
        return "닉네임은 앞뒤 공백을 제외하고 2~20자로 입력해 주세요.";
      }
      // 성공하면 서버가 표시를 지우고, 새 스냅샷을 받은 루트 가드가 이 화면을
      // 닫는다. 여기서 따로 이동하면 두 번 움직인다.
      await updateNickname(nextNickname);
    });

  return (
    <ModalFormScreen
      footer={
        <View style={styles.footer}>
          <PrimaryButton
            label="변경하고 참여하기"
            loading={submitting}
            onPress={() => void save()}
          />
          <Pressable
            accessibilityRole="button"
            disabled={submitting}
            onPress={confirmLeave}
            style={({ pressed }) => [
              styles.leaveButton,
              pressed && styles.leaveButtonPressed,
            ]}
          >
            <Text style={styles.leaveLabel}>방 나가기</Text>
          </Pressable>
        </View>
      }
      onBack={confirmLeave}
      testID="nickname-required-screen"
      title="닉네임 변경"
    >
      <NoticeBanner icon="alert-circle-outline" style={styles.notice} tone="info">
        먼저 참여한 같은 닉네임의 멤버가 있습니다. 닉네임을 변경해야 참여할 수
        있습니다.
      </NoticeBanner>

      <Field
        autoCapitalize="none"
        autoCorrect={false}
        editable={!submitting}
        error={error ?? undefined}
        label="닉네임"
        maxLength={20}
        onChangeText={(value) => {
          setError(null);
          setNickname(value);
        }}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        value={nickname}
      />
      <Text style={styles.hint}>
        지금 변경하면 7일 동안 다시 변경할 수 없습니다.
      </Text>
    </ModalFormScreen>
  );
}

const styles = StyleSheet.create({
  notice: { marginBottom: spacing.xxl },
  hint: {
    marginTop: spacing.md,
    color: palette.muted,
    fontFamily: fonts.hand,
    fontSize: 12,
    lineHeight: 20,
  },
  footer: { marginTop: spacing.xxxl, gap: spacing.sm, paddingBottom: spacing.xxl },
  leaveButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  leaveButtonPressed: { opacity: 0.6 },
  leaveLabel: { color: palette.muted, fontFamily: fonts.hand, fontSize: 14 },
});
