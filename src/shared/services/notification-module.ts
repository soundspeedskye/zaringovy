/** 지원 여부를 확인한 뒤 호출한다. 정적 import는 Android Expo Go에서 앱 시작을 막는다. */
export function getNotificationModule(): typeof import('expo-notifications') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications');
}
