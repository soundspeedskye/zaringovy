/**
 * 원격 푸시 payload에는 외부 URL 대신 앱 내부 경로만 넣는다.
 *
 * 서버가 보내는 데이터도 신뢰 경계 밖에 있으므로, router에 그대로 넘기지 않고
 * 실제로 지원하는 경로와 식별자 형태만 허용한다. 알림 본문에는 개인정보를 싣지
 * 않고 여기의 route와 commentId 같은 식별자만 넣는다.
 */
export type PushNotificationDestination =
  | { pathname: '/expense/[id]'; params: { id: string; cid?: string } }
  | { pathname: '/community/[id]'; params: { id: string } }
  | { pathname: '/notifications' };

export function pushNotificationDestination(
  value: unknown,
): PushNotificationDestination | null {
  if (!isRecord(value) || typeof value.route !== 'string') return null;

  const route = value.route;
  const expense = /^\/expense\/([^/?#]+)$/u.exec(route);
  if (expense) {
    const commentId = typeof value.commentId === 'string' ? value.commentId : undefined;
    return {
      pathname: '/expense/[id]',
      params: { id: expense[1], ...(commentId ? { cid: commentId } : {}) },
    };
  }

  const post = /^\/community\/([^/?#]+)$/u.exec(route);
  if (post) return { pathname: '/community/[id]', params: { id: post[1] } };

  return route === '/notifications' ? { pathname: '/notifications' } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
