import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * 기기 로컬 알림은 모두 걷어냈고, 이전 빌드가 남긴 예약만 정리한다.
 *
 * 다만 이전 빌드가 OS에 걸어둔 예약은 앱에서 코드를 지운다고 사라지지 않는다.
 * 주차 알림은 그 주차가 끝날 때까지, 예외 보류 리마인더는 보정 마감까지 매일
 * 계속 울린다. 그래서 실행할 때마다 남은 예약을 정리한다.
 *
 * 원격 푸시는 사용자가 아직 확인하지 않았을 수 있으므로 dismiss하지 않는다.
 * 이 앱은 예약 알림을 더 이상 만들지 않으므로 여기서 지우는 건 전부 옛 빌드가
 * 남긴 것이다. 모든 사용자가 이 빌드를 한 번씩 실행하고 나면 지워도 된다.
 */
export async function cancelLegacyDeviceNotifications(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Notifications.cancelAllScheduledNotificationsAsync();
}
