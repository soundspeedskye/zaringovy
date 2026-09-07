import { describe, expect, it } from 'vitest';

import { translateError } from '@/shared/api/supabase/errors';

describe('방 안 닉네임 오류', () => {
  it('같은 방 중복은 무엇이 문제인지 그대로 말한다', () => {
    const error = translateError(
      { code: 'P0001', message: 'ROOM_NICKNAME_TAKEN' },
      '닉네임을 변경하지 못했어요.',
    );

    expect(error.code).toBe('ROOM_NICKNAME_TAKEN');
    expect(error.message).toContain('이 방에서 이미 사용 중인 닉네임입니다.');
  });

  // 게이트는 42501로 올라온다. 일반 분기에 먼저 잡히면 '권한이 없어요'가 되어,
  // 닉네임만 바꾸면 풀린다는 사실이 사라진다.
  it('쓰기 차단은 권한 오류로 뭉뚱그리지 않는다', () => {
    const error = translateError(
      { code: '42501', message: 'NICKNAME_CHANGE_REQUIRED' },
      '지출을 저장하지 못했어요.',
    );

    expect(error.code).toBe('NICKNAME_CHANGE_REQUIRED');
    expect(error.message).toContain('닉네임을 변경해야');
  });

  it('7일 제한 안내는 그대로 남는다', () => {
    const error = translateError(
      { code: 'P0001', message: 'NICKNAME_COOLDOWN' },
      '닉네임을 변경하지 못했어요.',
    );

    expect(error.code).toBe('NICKNAME_COOLDOWN');
  });
});
