import type { NotificationResponse } from 'expo-notifications';
import { useRouter } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { pushNotificationDestination } from '@/shared/lib/push-notification-destination';
import { recordAppActivity } from '@/shared/services/engagement-activity';
import { getFirebaseMessagingModule } from '@/shared/services/firebase-messaging-module';
import { getNotificationModule } from '@/shared/services/notification-module';
import {
  registerPushNotificationsForUser,
  supportsPushNotifications,
  syncPushToken,
} from '@/shared/services/push-notifications';
import type { RemoteMessage } from '@react-native-firebase/messaging';

const activityHeartbeatMs = 15 * 60 * 1000;
const activityWriteIntervalMs = 5 * 60 * 1000;

/** 로그인 세션에 연결된 활동·FCM 토큰과 알림 탭 이동을 관리한다. */
export function PushNotificationProvider({
  children,
  userId,
}: PropsWithChildren<{ userId: string | null }>) {
  const router = useRouter();
  const handledInitialResponse = useRef(false);

  useEffect(() => {
    if (!userId) return;

    let lastRecordedAt = 0;
    let disposed = false;

    const record = () => {
      const now = Date.now();
      if (now - lastRecordedAt < activityWriteIntervalMs) return;
      lastRecordedAt = now;
      void recordAppActivity().catch(() => {
        if (!disposed) lastRecordedAt = 0;
      });
    };

    record();
    const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') record();
    });
    const heartbeat = setInterval(() => {
      if (AppState.currentState === 'active') record();
    }, activityHeartbeatMs);

    return () => {
      disposed = true;
      subscription.remove();
      clearInterval(heartbeat);
    };
  }, [userId]);

  useEffect(() => {
    if (!userId || !supportsPushNotifications()) return;

    try {
      const FirebaseMessaging = getFirebaseMessagingModule();
      const messaging = FirebaseMessaging.getMessaging();
      // 토큰 등록 실패가 앱 시작을 막아서는 안 된다. 다음 앱 실행·토큰 교체 때
      // 다시 시도하며, 실제 원인은 개발 빌드의 로그에서 확인할 수 있다.
      void registerPushNotificationsForUser().catch(() => undefined);

      const unsubscribeToken = FirebaseMessaging.onTokenRefresh(messaging, (token) => {
        void syncPushToken(token).catch(() => undefined);
      });

      return () => {
        unsubscribeToken();
      };
    } catch {
      // Expo Go에는 RNFirebase 네이티브 모듈이 없을 수 있다. 개발 빌드에서만
      // FCM을 활성화하고, 모듈 부재가 앱 시작을 막지 않게 한다.
      return;
    }
  }, [userId]);

  useEffect(() => {
    if (!userId || !supportsPushNotifications()) return;
    const Notifications = getNotificationModule();

    const openExpoNotification = (response: NotificationResponse): boolean => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return false;
      const destination = pushNotificationDestination(
        response.notification.request.content.data,
      );
      router.replace(destination as never);
      return true;
    };
    const openFcmNotification = (message: RemoteMessage): void => {
      const destination = pushNotificationDestination(message.data);
      router.replace(destination as never);
    };

    const expoSubscription = Notifications.addNotificationResponseReceivedListener(
      openExpoNotification,
    );
    let unsubscribeFcmOpened: (() => void) | undefined;
    let FirebaseMessaging: ReturnType<typeof getFirebaseMessagingModule> | undefined;
    try {
      FirebaseMessaging = getFirebaseMessagingModule();
      const messaging = FirebaseMessaging.getMessaging();
      unsubscribeFcmOpened = FirebaseMessaging.onNotificationOpenedApp(
        messaging,
        openFcmNotification,
      );
    } catch {
      // Expo Go 또는 네이티브 설정 전 상태에서는 Expo 알림 listener만 사용한다.
    }

    if (!handledInitialResponse.current) {
      handledInitialResponse.current = true;
      void (async () => {
        if (FirebaseMessaging) {
          try {
            const initialFcmNotification = await FirebaseMessaging.getInitialNotification(
              FirebaseMessaging.getMessaging(),
            );
            if (initialFcmNotification) {
              openFcmNotification(initialFcmNotification);
              return;
            }
          } catch {
            // FCM 초기 알림 조회가 실패해도 Expo local notification 조회는 시도한다.
          }
        }

        const response = await Notifications.getLastNotificationResponseAsync();
        if (response && openExpoNotification(response)) {
          await Notifications.clearLastNotificationResponseAsync();
        }
      })().catch(() => undefined);
    }

    return () => {
      expoSubscription.remove();
      unsubscribeFcmOpened?.();
    };
  }, [router, userId]);

  return children;
}
