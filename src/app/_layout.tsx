import 'react-native-url-polyfill/auto';

import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { palette } from '@/shared/config/design';
import { AppProvider } from '@/shared/providers/app-provider';
import { AppDialogProvider } from '@/shared/providers/app-dialog-provider';
import { PushNotificationProvider } from '@/shared/providers/push-notification-provider';
import { cancelLegacyDeviceNotifications } from '@/shared/services/device-notification-cleanup';
import { configurePushNotificationPresentation } from '@/shared/services/push-notifications';
import { SessionProvider, useSession } from '@/shared/providers/session-provider';

void SplashScreen.preventAutoHideAsync();
configurePushNotificationPresentation();

export default function RootLayout() {
  // 폰트 패밀리명은 이 map의 key로 등록된다(fonts.hand 토큰과 일치).
  const [fontsLoaded, fontError] = useFonts({
    'IBMPlexSansKR-Regular': require('../../assets/fonts/IBMPlexSansKR-Regular.ttf'),
    'IBMPlexSansKR-SemiBold': require('../../assets/fonts/IBMPlexSansKR-SemiBold.ttf'),
  });

  // 스플래시는 폰트 로드만으로 내리지 않는다. 세션이 확정될 때까지 유지해
  // (AuthenticatedApp에서 hideAsync) 세션 확정 전 데이터 계층 마운트를 막는다.
  if (!fontsLoaded && !fontError) return null;

  return (
    <KeyboardProvider>
      <SessionProvider>
        <AuthenticatedApp />
      </SessionProvider>
    </KeyboardProvider>
  );
}

function AuthenticatedApp() {
  const router = useRouter();
  const segments = useSegments();
  const { loading, recoveryMode, session } = useSession();
  const inAuthGroup = segments[0] === '(auth)';
  // 딥링크는 경로만 보고 이 화면을 띄우므로, 링크가 거절돼 복구 세션이 서지
  // 않아도 사용자는 새 비밀번호 입력칸 앞에 서게 된다. 입력해봐야 실패한다.
  const onRecoveryScreen = inAuthGroup && segments[1] === 'reset-password';
  // 세션 부트스트랩 중. 이 구간엔 아직 유저가 확정되지 않아 데이터 계층을
  // 마운트하면 signed-out 마운트에서 전체 조회가 한 번 낭비된다(재방문 사용자).
  const bootstrapping = loading;

  useEffect(() => {
    if (loading) return;
    // 복구 모드는 검증이 끝나기 전에 켜지므로, 정상 링크가 확인을 기다리는
    // 동안에는 여기서 되돌리지 않는다. 거절된 링크만 로그인 화면으로 보내고,
    // 이유는 그 화면의 안내가 말해준다.
    if (!session && (!inAuthGroup || (onRecoveryScreen && !recoveryMode))) {
      router.replace('/sign-in');
    }
    if (session && inAuthGroup && !recoveryMode) router.replace('/');
  }, [inAuthGroup, loading, onRecoveryScreen, recoveryMode, router, session]);

  useEffect(() => {
    // 세션 확정까지 스플래시를 유지하고, 준비되면 내린다.
    if (!bootstrapping) void SplashScreen.hideAsync();
  }, [bootstrapping]);

  useEffect(() => {
    // 옛 빌드가 OS에 걸어둔 로컬 알림 예약을 정리한다. 이 앱은 기기 알림을
    // 더 이상 만들지 않고, 소식은 앱 안 소식함으로만 전달한다.
    void cancelLegacyDeviceNotifications();
  }, []);

  // 세션이 확정된 뒤에만 데이터 Provider를 마운트한다. 스플래시가 이 구간을
  // 덮으므로 화면 깜빡임 없이 전체 조회가 정확히 1회만 실행된다.
  if (bootstrapping) return null;

  return (
    <AppProvider
      key={session?.user.id ?? 'signed-out'}
      sessionUserId={session?.user.id ?? null}>
      <PushNotificationProvider userId={session?.user.id ?? null}>
        <AppDialogProvider>
          <StatusBar style="dark" />
          {/*
            fullScreenGestureEnabled: iOS 26은 기본값이 true지만 18 이하는 false라,
            구버전에서는 화면 맨 왼쪽 가장자리에서만 스와이프 뒤로가기가 먹었다.
            버전과 무관하게 화면 어디서나 밀어 뒤로 가도록 명시한다.
            (대가: iOS 18 이하에서는 스와이프 전환이 simple_push가 되어 시차 효과가 빠진다)
          */}
          <Stack
            screenOptions={{
              headerShown: false,
              fullScreenGestureEnabled: true,
              contentStyle: { backgroundColor: palette.cream },
            }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="room/create" options={{ presentation: 'modal' }} />
            <Stack.Screen name="room/edit" options={{ presentation: 'modal' }} />
            <Stack.Screen name="room/join" options={{ presentation: 'modal' }} />
            <Stack.Screen name="room/leave" options={{ presentation: 'modal' }} />
            <Stack.Screen name="community/[id]" />
            <Stack.Screen name="community/new" options={{ presentation: 'modal' }} />
            <Stack.Screen name="profile/edit" options={{ presentation: 'modal' }} />
            <Stack.Screen name="account/delete" options={{ presentation: 'modal' }} />
            <Stack.Screen name="expense/new" options={{ presentation: 'modal' }} />
            <Stack.Screen name="expense/[id]" />
            <Stack.Screen name="notifications" />
            <Stack.Screen name="room/member/[userId]" />
            <Stack.Screen name="history/index" />
            <Stack.Screen name="history/[id]" />
          </Stack>
        </AppDialogProvider>
      </PushNotificationProvider>
    </AppProvider>
  );
}
