import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getSupabaseClient } from '@/shared/api/supabase-client';

type RegistrationResult = 'registered' | 'denied' | 'unsupported';

/** iOS 1차 배포에서는 iOS 기기만 원격 푸시를 등록한다. */
export function supportsPushNotifications(): boolean {
  return Platform.OS === 'ios';
}

/** 포그라운드에서도 서버 푸시를 배너와 알림 목록에 표시한다. */
export function configurePushNotificationPresentation(): void {
  if (!supportsPushNotifications()) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * 권한을 확인하고 Expo Push Token을 발급해 현재 로그인 계정에 연결한다.
 * 권한 거절은 정상적인 사용자 선택이므로 예외가 아니라 denied로 돌려준다.
 */
export async function registerPushNotificationsForUser(
  userId: string,
): Promise<RegistrationResult> {
  if (!supportsPushNotifications()) return 'unsupported';

  const permission = await ensurePushPermission();
  if (!permission) return 'denied';

  const token = await getExpoPushToken();
  await syncPushToken(userId, token);
  return 'registered';
}

/** 앱이 실행 중 토큰이 교체됐을 때 provider listener가 새 토큰을 즉시 반영한다. */
export async function syncPushToken(userId: string, token: string): Promise<void> {
  if (!supportsPushNotifications()) return;

  const client = getSupabaseClient();
  // device_push_tokens의 UPDATE 권한은 user_id를 제외한 열에만 있다. upsert는
  // 충돌 시 user_id까지 갱신하려 하므로, 먼저 자기 토큰을 조회해 INSERT와 UPDATE를
  // 분리한다. RLS가 다른 계정의 토큰 행을 돌려주지 않는 것도 함께 보장된다.
  const { data: existing, error: readError } = await client
    .from('device_push_tokens')
    .select('id')
    .eq('token', token)
    .maybeSingle();
  if (readError) throw readError;

  const record = {
    platform: 'ios',
    is_enabled: true,
    last_seen_at: new Date().toISOString(),
  };
  const { error } = existing
    ? await client.from('device_push_tokens').update(record).eq('id', existing.id)
    : await client.from('device_push_tokens').insert({ user_id: userId, token, ...record });
  if (error) throw error;
}

/**
 * 로그아웃 직전에 현재 기기 토큰만 끈다. 다른 기기의 토큰은 그대로 둔다.
 * 실패해도 로그아웃 자체를 막으면 안 되므로 호출부가 오류를 삼킨다.
 */
export async function disableCurrentPushNotificationsForUser(
  userId: string,
): Promise<void> {
  if (!supportsPushNotifications()) return;

  const permission = await Notifications.getPermissionsAsync();
  if (!hasPushPermission(permission)) return;

  const token = await getExpoPushToken();
  const { error } = await getSupabaseClient()
    .from('device_push_tokens')
    .update({ is_enabled: false, last_seen_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('token', token);
  if (error) throw error;
}

async function ensurePushPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (hasPushPermission(current)) return true;

  // iOS에서는 권한을 이미 거절한 뒤 다시 requestPermissionsAsync를 호출해도
  // 시스템 팝업이 나오지 않는다. 이 경우 설정 화면 안내는 UX 단계에서 제공한다.
  if (!current.canAskAgain) return false;
  return hasPushPermission(await Notifications.requestPermissionsAsync());
}

function hasPushPermission(
  permission: Notifications.NotificationPermissionsStatus,
): boolean {
  const status = permission.ios?.status;
  return status === Notifications.IosAuthorizationStatus.AUTHORIZED
    || status === Notifications.IosAuthorizationStatus.PROVISIONAL
    || status === Notifications.IosAuthorizationStatus.EPHEMERAL;
}

async function getExpoPushToken(): Promise<string> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId
    ?? Constants.easConfig?.projectId;
  if (!projectId) throw new Error('EAS 프로젝트 ID를 찾지 못해 푸시 토큰을 등록할 수 없어요.');

  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}
