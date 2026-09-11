/** 원격 푸시를 탭하면 payload와 관계없이 앱 홈으로 연다. */
export type PushNotificationDestination = { pathname: '/' };

export function pushNotificationDestination(
  _value: unknown,
): PushNotificationDestination {
  // Push payloads are outside the app's trust boundary. Keeping the argument in
  // the helper preserves the call shape while deliberately ignoring all routes.
  return { pathname: '/' };
}
