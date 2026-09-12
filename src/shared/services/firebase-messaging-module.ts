/** 지원 여부를 확인한 뒤 호출한다. 정적 import는 Expo Go에서 앱 시작을 막을 수 있다. */
export function getFirebaseMessagingModule(): typeof import('@react-native-firebase/messaging') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@react-native-firebase/messaging');
}
