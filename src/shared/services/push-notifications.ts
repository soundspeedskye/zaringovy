import * as Application from 'expo-application';
import Constants from 'expo-constants';
import type { NotificationPermissionsStatus } from 'expo-notifications';
import { Platform } from 'react-native';

import { getSupabaseClient } from '@/shared/api/supabase-client';
import { getNotificationModule } from '@/shared/services/notification-module';

type RegistrationResult = 'registered' | 'denied' | 'unsupported';

/** iOS 1차 배포에서는 iOS 기기만 원격 푸시를 등록한다. */
export function supportsPushNotifications(): boolean {
  return Platform.OS === 'ios';
}

/** 포그라운드에서도 서버 푸시를 배너와 알림 목록에 표시한다. */
export function configurePushNotificationPresentation(): void {
  if (!supportsPushNotifications()) return;
  const Notifications = getNotificationModule();
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
export async function registerPushNotificationsForUser(): Promise<RegistrationResult> {
  if (!supportsPushNotifications()) return 'unsupported';

  const permission = await ensurePushPermission();
  if (!permission) return 'denied';

  const token = await getExpoPushToken();
  await syncPushToken(token);
  return 'registered';
}

/** 앱이 실행 중 토큰이 교체됐을 때 provider listener가 새 토큰을 즉시 반영한다. */
export async function syncPushToken(token: string): Promise<void> {
  if (!supportsPushNotifications()) return;

  const deviceId = await getPushDeviceId();
  const client = getSupabaseClient();
  // Expo 토큰은 계정이 아니라 앱 설치/기기 단위다. 계정을 바꾸면 서버 RPC가
  // 해당 토큰을 현재 세션 계정으로 원자적으로 이전해 중복 키 충돌을 막는다.
  const { error } = await client.rpc('claim_device_push_token', {
    p_platform: 'ios',
    p_token: token,
    p_device_id: deviceId,
  });
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

  const Notifications = getNotificationModule();
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
  const Notifications = getNotificationModule();
  const current = await Notifications.getPermissionsAsync();
  if (hasPushPermission(current)) return true;

  // iOS에서는 권한을 이미 거절한 뒤 다시 requestPermissionsAsync를 호출해도
  // 시스템 팝업이 나오지 않는다. 이 경우 설정 화면 안내는 UX 단계에서 제공한다.
  if (!current.canAskAgain) return false;
  return hasPushPermission(await Notifications.requestPermissionsAsync());
}

function hasPushPermission(
  permission: NotificationPermissionsStatus,
): boolean {
  const Notifications = getNotificationModule();
  const status = permission.ios?.status;
  return status === Notifications.IosAuthorizationStatus.AUTHORIZED
    || status === Notifications.IosAuthorizationStatus.PROVISIONAL
    || status === Notifications.IosAuthorizationStatus.EPHEMERAL;
}

async function getExpoPushToken(): Promise<string> {
  const Notifications = getNotificationModule();
  const projectId = Constants.expoConfig?.extra?.eas?.projectId
    ?? Constants.easConfig?.projectId;
  if (!projectId) throw new Error('EAS 프로젝트 ID를 찾지 못해 푸시 토큰을 등록할 수 없어요.');

  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

/**
 * IDFV는 같은 앱 공급자의 동일 iOS 기기를 구분한다. 기기 재시작 직후 잠금 상태에서는
 * 일시적으로 null일 수 있으므로, 그 경우에는 다음 앱 실행에서 토큰 등록을 재시도한다.
 */
async function getPushDeviceId(): Promise<string> {
  const identifierForVendor = await Application.getIosIdForVendorAsync();
  if (!identifierForVendor) {
    throw new Error('iOS 기기 식별자를 아직 가져오지 못해 푸시 토큰 등록을 다시 시도해야 해요.');
  }

  return `ios:${identifierForVendor}`;
}
