import { describe, expect, it } from 'vitest';

import { pushNotificationDestination } from '@/shared/lib/push-notification-destination';

describe('pushNotificationDestination', () => {
  it('routes an expense notification and preserves an optional comment id', () => {
    expect(
      pushNotificationDestination({
        route: '/expense/expense-123',
        commentId: 'comment-123',
      }),
    ).toEqual({
      pathname: '/expense/[id]',
      params: { id: 'expense-123', cid: 'comment-123' },
    });
  });

  it('routes a community post notification', () => {
    expect(pushNotificationDestination({ route: '/community/post-123' })).toEqual({
      pathname: '/community/[id]',
      params: { id: 'post-123' },
    });
  });

  it('refuses arbitrary routes and malformed payloads', () => {
    expect(pushNotificationDestination({ route: 'https://example.com' })).toBeNull();
    expect(pushNotificationDestination({ route: '/profile/edit' })).toBeNull();
    expect(pushNotificationDestination({ route: '/expense/' })).toBeNull();
    expect(pushNotificationDestination(null)).toBeNull();
  });
});
