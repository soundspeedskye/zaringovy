import type { NotificationResponse } from 'expo-notifications';
import { useRouter } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { pushNotificationDestination } from '@/shared/lib/push-notification-destination';
import { recordAppActivity } from '@/shared/services/engagement-activity';
import { getNotificationModule } from '@/shared/services/notification-module';
import {
  registerPushNotificationsForUser,
  supportsPushNotifications,
  syncPushToken,
} from '@/shared/services/push-notifications';

const activityHeartbeatMs = 15 * 60 * 1000;
const activityWriteIntervalMs = 5 * 60 * 1000;

/** 로그인 세션에 연결된 활동·기기 토큰과 알림 탭 이동을 관리한다. */
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
    const Notifications = getNotificationModule();

    // 토큰 등록 실패가 앱 시작을 막아서는 안 된다. 다음 앱 실행·토큰 교체 때
    // 다시 시도하며, 실제 원인은 개발 빌드의 로그에서 확인할 수 있다.
    void registerPushNotificationsForUser().catch(() => undefined);

    const subscription = Notifications.addPushTokenListener((token) => {
      void syncPushToken(token.data).catch(() => undefined);
    });
    return () => subscription.remove();
  }, [userId]);

  useEffect(() => {
    if (!userId || !supportsPushNotifications()) return;
    const Notifications = getNotificationModule();

    const open = (response: NotificationResponse): boolean => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return false;
      const destination = pushNotificationDestination(
        response.notification.request.content.data,
      );
      router.replace(destination as never);
      return true;
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    if (!handledInitialResponse.current) {
      handledInitialResponse.current = true;
      void Notifications.getLastNotificationResponseAsync().then(async (response) => {
        if (response && open(response)) {
          await Notifications.clearLastNotificationResponseAsync();
        }
      });
    }
    return () => subscription.remove();
  }, [router, userId]);

  return children;
}
