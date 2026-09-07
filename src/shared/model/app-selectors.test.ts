import { describe, expect, it } from 'vitest';

import type { AppSnapshot } from '@/shared/api/types';
import { buildAppIndexes } from '@/shared/model/app-indexes';
import { deriveAppState } from '@/shared/model/app-selectors';
import { createTestSnapshot } from '@/test/app-snapshot-fixture';

describe('nicknameChangeRequiredRoomId', () => {
  it('중복 표시가 없으면 비어 있다', () => {
    expect(derive(createTestSnapshot())).toBeNull();
  });

  it('내 활성 멤버십에 표시가 있으면 그 방을 가리킨다', () => {
    const snapshot = withBlockedMember(createTestSnapshot(), 'user-me');
    expect(derive(snapshot)).toBe('room-test');
  });

  // 차단은 그 사람의 화면에서만 성립한다. 같은 방의 다른 멤버가 이름을 바꿔야
  // 한다고 해서 내 화면이 막히면 안 된다.
  it('다른 사람의 표시는 내 화면을 막지 않는다', () => {
    const snapshot = withBlockedMember(createTestSnapshot(), 'user-other');
    expect(derive(snapshot)).toBeNull();
  });

  // 나간 방의 표시는 남아 있어도 더 이상 막을 활동이 없다. 여기서 걸러내지
  // 않으면 방을 나간 사용자가 닉네임 화면에 갇힌다.
  it('이미 나간 방의 표시는 무시한다', () => {
    const snapshot = withBlockedMember(createTestSnapshot(), 'user-me');
    snapshot.roomMembers = snapshot.roomMembers.map((member) =>
      member.userId === 'user-me' ? { ...member, status: 'LEFT' as const } : member,
    );
    expect(derive(snapshot)).toBeNull();
  });

  it('멤버십이 그대로면 이전 결과를 재사용한다', () => {
    const snapshot = withBlockedMember(createTestSnapshot(), 'user-me');
    const indexes = buildAppIndexes(snapshot);
    const previous = deriveAppState(snapshot, indexes);
    const next: AppSnapshot = { ...snapshot, comments: [] };

    const derived = deriveAppState(next, buildAppIndexes(next), snapshot, previous);

    expect(derived.nicknameChangeRequiredRoomId).toBe(
      previous.nicknameChangeRequiredRoomId,
    );
  });
});

function derive(snapshot: AppSnapshot): string | null {
  return deriveAppState(snapshot, buildAppIndexes(snapshot))
    .nicknameChangeRequiredRoomId;
}

function withBlockedMember(snapshot: AppSnapshot, userId: string): AppSnapshot {
  return {
    ...snapshot,
    roomMembers: snapshot.roomMembers.map((member) =>
      member.userId === userId
        ? { ...member, nicknameChangeRequired: true }
        : member,
    ),
  };
}
