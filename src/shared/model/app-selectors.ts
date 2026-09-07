import type { AppSnapshot, Period, Profile, Room } from '@/shared/api/types';
import type { AppIndexes } from '@/shared/model/app-indexes';

export type AppDerivedState = {
  currentUser: Profile | null;
  activeRoom: Room | null;
  currentPeriod: Period | null;
  pastPeriods: Period[];
  /**
   * 먼저 참여한 같은 닉네임의 멤버가 있어 닉네임을 바꿔야 하는 방. 서버 스냅샷에서
   * 그대로 읽으므로 앱을 다시 켜도 같은 값이 나오고, 라우팅 가드가 이 값만 보고
   * 필수 변경 화면을 띄운다.
   */
  nicknameChangeRequiredRoomId: string | null;
};

export function deriveAppState(
  snapshot: AppSnapshot | null,
  indexes: AppIndexes,
  previousSnapshot: AppSnapshot | null = null,
  previousState?: AppDerivedState,
): AppDerivedState {
  if (!snapshot) {
    return {
      currentUser: null,
      activeRoom: null,
      currentPeriod: null,
      pastPeriods: [],
      nicknameChangeRequiredRoomId: null,
    };
  }
  const sameUser = previousSnapshot?.currentUserId === snapshot.currentUserId;
  const currentUser = previousState
    && sameUser
    && previousSnapshot?.profiles === snapshot.profiles
    ? previousState.currentUser
    : indexes.profileById.get(snapshot.currentUserId) ?? null;
  const activeRoom = previousState
    && sameUser
    && previousSnapshot?.rooms === snapshot.rooms
    && previousSnapshot.roomMembers === snapshot.roomMembers
    ? previousState.activeRoom
    : selectActiveRoom(snapshot);
  const currentPeriod = previousState
    && previousSnapshot?.periods === snapshot.periods
    && activeRoom === previousState.activeRoom
    ? previousState.currentPeriod
    : selectCurrentPeriod(snapshot, activeRoom);
  const pastPeriods = previousState
    && sameUser
    && previousSnapshot?.periods === snapshot.periods
    && previousSnapshot.roomMembers === snapshot.roomMembers
    ? previousState.pastPeriods
    : selectPastPeriods(snapshot);
  const nicknameChangeRequiredRoomId = previousState
    && sameUser
    && previousSnapshot?.roomMembers === snapshot.roomMembers
    ? previousState.nicknameChangeRequiredRoomId
    : selectNicknameChangeRequiredRoomId(snapshot);
  return {
    currentUser,
    activeRoom,
    currentPeriod,
    pastPeriods,
    nicknameChangeRequiredRoomId,
  };
}

/**
 * 방을 열려면 닉네임부터 바꿔야 하는 멤버십. 이용자는 활성 방을 하나만 가지므로
 * 가장 먼저 걸리는 하나면 충분하다. 나간 방(status !== 'ACTIVE')의 표시는 남아
 * 있어도 더 이상 막을 것이 없으니 보지 않는다.
 */
function selectNicknameChangeRequiredRoomId(snapshot: AppSnapshot): string | null {
  const blocked = snapshot.roomMembers.find(
    (member) =>
      member.userId === snapshot.currentUserId
      && member.status === 'ACTIVE'
      && member.nicknameChangeRequired,
  );
  return blocked?.roomId ?? null;
}

function selectActiveRoom(snapshot: AppSnapshot | null): Room | null {
  if (!snapshot) return null;
  const myRoomIds = new Set(
    snapshot.roomMembers
      .filter((member) => member.userId === snapshot.currentUserId && member.status === 'ACTIVE')
      .map((member) => member.roomId),
  );
  return snapshot.rooms.find((room) => myRoomIds.has(room.id) && room.status === 'OPEN') ?? null;
}

function selectCurrentPeriod(snapshot: AppSnapshot | null, activeRoom: Room | null): Period | null {
  if (!snapshot || !activeRoom) return null;
  return (
    snapshot.periods
      .filter((period) => period.roomId === activeRoom.id && period.phase !== 'ARCHIVED')
      .sort((left, right) => right.weekStart.localeCompare(left.weekStart))[0] ?? null
  );
}

function selectPastPeriods(snapshot: AppSnapshot | null): Period[] {
  if (!snapshot) return [];
  const myRoomIds = new Set(
    snapshot.roomMembers
      .filter((member) => member.userId === snapshot.currentUserId)
      .map((member) => member.roomId),
  );
  return snapshot.periods
    .filter((period) => myRoomIds.has(period.roomId) && period.phase === 'ARCHIVED')
    .sort((left, right) => right.weekStart.localeCompare(left.weekStart));
}
