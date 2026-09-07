import { asObject } from './json';

/** 리포지토리 계층이 던지는 오류. 매퍼와 리포지토리 양쪽이 쓰므로
    순환 import를 피하려고 별도 모듈에 둔다. */
export class RepositoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'RepositoryError';
  }
}

/** Postgres 오류를 사용자에게 보여줄 메시지로 옮긴다. */

export function translateError(error: unknown, fallback: string): RepositoryError {
  if (error instanceof RepositoryError) return error;
  const value = asObject(error);
  const code = typeof value?.code === 'string' ? value.code : 'SUPABASE_ERROR';
  const message = typeof value?.message === 'string' ? value.message : '';
  const normalized = message.toLowerCase();
  const status = value?.status ?? value?.statusCode;

  // PostgREST의 JWT 오류는 error 객체에 status가 실리지 않아 위 status 검사에
  // 걸리지 않는다(PostgrestError는 code·message·details·hint만 가진다).
  // PGRST301은 디코딩·서명 실패, PGRST302는 익명 접근 차단으로 둘 다 다시
  // 로그인해야 풀린다. PGRST303(클레임 검증 실패)은 여기 넣지 않는다 —
  // 서버 간 시계 편차로 갓 발급된 토큰이 잠깐 거부되는 경우가 섞여 있고,
  // AUTH_REQUIRED는 오프라인 큐에서 영구 실패로 취급돼 쌓인 변경이 버려진다.
  // 그 편차는 clock-skew-retry의 재시도가 흡수한다.
  const jwtErrorCode = code === 'PGRST301' || code === 'PGRST302';
  if (
    Number(status) === 401 ||
    jwtErrorCode ||
    normalized.includes('jwt expired') ||
    normalized.includes('invalid jwt')
  ) {
    return new RepositoryError('AUTH_REQUIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.', { cause: error });
  }
  if (message === 'NICKNAME_COOLDOWN') {
    return new RepositoryError('NICKNAME_COOLDOWN', '닉네임은 7일에 한 번만 변경할 수 있어요.', { cause: error });
  }
  // 방 안 닉네임 규칙. 아래 42501/P0001 일반 분기보다 먼저 봐야 한다. 그 분기는
  // '권한이 없어요'로 뭉뚱그려, 무엇을 하면 풀리는지 알려주지 못한다.
  if (message === 'ROOM_NICKNAME_TAKEN') {
    return new RepositoryError('ROOM_NICKNAME_TAKEN', '이 방에서 이미 사용 중인 닉네임입니다.', { cause: error });
  }
  if (message === 'NICKNAME_CHANGE_REQUIRED') {
    return new RepositoryError('NICKNAME_CHANGE_REQUIRED', '닉네임을 변경해야 방에서 활동할 수 있어요.', { cause: error });
  }
  if (message === 'INVALID_NICKNAME') {
    return new RepositoryError('INVALID_NICKNAME', '닉네임은 앞뒤 공백을 제외하고 2~20자로 입력해 주세요.', { cause: error });
  }
  if (code === '40001' || normalized.includes('version conflict')) {
    return new RepositoryError('VERSION_CONFLICT', '다른 기기에서 먼저 수정했어요. 새로고침한 뒤 다시 시도해 주세요.', { cause: error });
  }
  if (code === '42501' || normalized.includes('permission denied')) {
    return new RepositoryError('FORBIDDEN', '이 작업을 수행할 권한이 없어요.', { cause: error });
  }
  if (normalized.includes('failed to fetch') || normalized.includes('network request failed')) {
    return new RepositoryError('NETWORK_ERROR', '네트워크 연결을 확인한 뒤 다시 시도해 주세요.', { cause: error });
  }
  const policyMessage = policyErrorMessage(normalized);
  return new RepositoryError(code, policyMessage ?? fallback, { cause: error });
}

export function policyErrorMessage(message: string): string | null {
  if (message.includes('authentication required')) return '로그인이 필요해요.';
  if (message.includes('room name')) return '방 이름을 확인해 주세요.';
  if (message.includes('holiday dataset does not cover')) return '이번 주 공휴일 데이터가 아직 준비되지 않았어요.';
  if (message.includes('published korean holiday dataset')) return '공휴일 데이터가 아직 준비되지 않았어요.';
  if (message.includes('capacity can only increase')) return '정원은 현재보다 크게, 최대 10명까지 설정할 수 있어요.';
  if (message.includes('closed rooms are read-only') || message.includes('closed rooms do not open')) {
    return '닫힌 방은 읽기 전용이에요.';
  }
  if (message.includes('expense adjustment deadline')) return '지출 보정 마감이 지나 수정할 수 없어요.';
  if (message.includes('writable only during active and adjustment')) return '현재는 지출을 입력하거나 수정할 수 없는 기간이에요.';
  if (message.includes('active period membership')) return '이번 주차 참여자만 지출을 기록할 수 있어요.';
  if (message.includes('active room membership')) return '방 참여자만 쓸 수 있어요.';
  if (message.includes('expense time is outside')) return '주차 기간과 내 합류일 안의 지출만 등록할 수 있어요.';
  if (message.includes('excluded holiday')) return '공휴일 지출은 주차 한도에 포함할 수 없어요.';
  if (message.includes('uploaded photo is required') || message.includes('photo upload')) return '마감 전에 지출 사진 1장 업로드를 완료해 주세요.';
  if (message.includes('room owner must select')) return '방장이 나가려면 다른 참여자에게 방장을 넘겨야 해요.';
  if (message.includes('comment edit window')) return '댓글은 작성 후 5분 안에만 수정할 수 있어요.';
  if (message.includes('poll has closed')) return '투표가 마감되었어요.';
  if (message.includes('comment is read-only')) return '정산이 끝난 주차의 댓글은 읽기 전용이에요.';
  if (message.includes('comment body')) return '댓글은 앞뒤 공백을 제외하고 1~500자로 입력해 주세요.';
  return null;
}

export function inviteError(code: string): RepositoryError {
  const messages: Record<string, string> = {
    INVALID_CODE: '참여 코드를 확인해 주세요.',
    RATE_LIMITED: '코드를 너무 자주 확인했어요. 10분 뒤 다시 시도해 주세요.',
    ROOM_CLOSED: '이미 닫힌 방이에요.',
    CAPACITY_FULL: '방 정원이 가득 찼어요.',
    ALREADY_PARTICIPATED: '이미 참여했거나 참여했던 방이에요.',
  };
  return new RepositoryError(code, messages[code] ?? '방에 참여할 수 없어요.');
}

// switch_room rolls the leave back and raises when the join half fails, tagging
// the reason as "switch_room join failed: <CODE>". Recover that code so the
// caller sees the same friendly message join_room would have produced; anything
// else (e.g. owner-successor rules from the leave half) falls through to the
// shared policy translator.

export function switchRoomError(error: unknown): RepositoryError {
  const value = asObject(error);
  const message = typeof value?.message === 'string' ? value.message : '';
  const matched = /switch_room join failed:\s*([A-Z_]+)/u.exec(message);
  if (matched) return inviteError(matched[1]);
  return translateError(error, '방을 옮기지 못했어요.');
}

export function isAlreadyExistsError(error: unknown): boolean {
  const value = asObject(error);
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  const status = value?.statusCode ?? value?.status;
  return Number(status) === 409 || message.includes('already exists') || message.includes('duplicate');
}
