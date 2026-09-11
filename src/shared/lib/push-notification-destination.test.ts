import { describe, expect, it } from 'vitest';

import { pushNotificationDestination } from '@/shared/lib/push-notification-destination';

describe('pushNotificationDestination', () => {
  it.each([
    { route: '/expense/expense-123', commentId: 'comment-123' },
    { route: '/community/post-123' },
    { route: '/profile/edit' },
    { route: 'https://example.com' },
    null,
  ])('always opens home for an arbitrary push payload', (payload) => {
    expect(pushNotificationDestination(payload)).toEqual({ pathname: '/' });
  });
});
