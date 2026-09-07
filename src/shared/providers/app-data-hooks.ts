import { useCallback } from 'react';
import type { Expense, Period, Profile, Room, RoomRole, WinnerNudgeGrant } from '@/shared/api/types';
import type { AppStoreState } from '@/shared/model/app-store';
import {
  shallowEqual,
  useAppStoreSelector,
} from '@/shared/providers/app-store-provider';
import { EMPTY_MEMBERS, useIndexedArray } from '@/shared/providers/store-hooks';

const EMPTY_IDS: string[] = [];

const EMPTY_ROOM_MEMBERS: RoomMemberSummary[] = [];

const EMPTY_APPROVERS: ReadonlySet<string> = new Set();

const EMPTY_PENDING_APPROVALS: PendingExceptionApproval[] = [];

export type RoomMemberSummary = {
  userId: string;
  nickname: string;
  avatar: string;
  avatarUri?: string;
  role: RoomRole;
  isCurrentUser: boolean;
};

const selectCurrentRoom = (state: AppStoreState) => ({
  currentUser: state.currentUser,
  activeRoom: state.activeRoom,
  currentPeriod: state.currentPeriod,
});

export function useCurrentRoom(): {
  currentUser: Profile | null;
  activeRoom: Room | null;
  currentPeriod: Period | null;
} {
  return useAppStoreSelector(
    selectCurrentRoom,
    shallowEqual,
  );
}

export function useActiveRoomMembers(roomId: string | undefined): RoomMemberSummary[] {
  const selector = useCallback(
    (state: AppStoreState): RoomMemberSummary[] => {
      const snapshot = state.snapshot;
      if (!roomId || !snapshot) return EMPTY_ROOM_MEMBERS;
      const currentUserId = snapshot.currentUserId;
      return snapshot.roomMembers
        .filter((member) => member.roomId === roomId && member.status === 'ACTIVE')
        .map((member) => {
          const profile = state.indexes.profileById.get(member.userId);
          return {
            userId: member.userId,
            nickname: profile?.nickname ?? '알 수 없음',
            avatar: profile?.avatar ?? '',
            avatarUri: profile?.avatarUri,
            role: member.role,
            isCurrentUser: member.userId === currentUserId,
          };
        });
    },
    [roomId],
  );
  return useAppStoreSelector(selector, roomMemberSummariesEqual);
}

function roomMemberSummariesEqual(
  left: readonly RoomMemberSummary[],
  right: readonly RoomMemberSummary[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const other = right[index];
    return (
      value.userId === other.userId &&
      value.nickname === other.nickname &&
      value.avatar === other.avatar &&
      value.avatarUri === other.avatarUri &&
      value.role === other.role &&
      value.isCurrentUser === other.isCurrentUser
    );
  });
}

export function useCrownIds(periodId: string | undefined): string[] {
  return useIndexedArray(
    useCallback(
      (state: AppStoreState) => {
        if (!periodId) return EMPTY_IDS;
        const period = state.indexes.periodById.get(periodId);
        if (!period || period.phase === 'WAITING' || period.isRestWeek) return EMPTY_IDS;
        return state.indexes.crownIdsByPeriodId.get(periodId) ?? EMPTY_IDS;
      },
      [periodId],
    ),
  );
}

export function useWinnerNudgeGrant(roomId: string | undefined): WinnerNudgeGrant | undefined {
  return useAppStoreSelector(
    useCallback((state: AppStoreState) => {
      if (!roomId) return undefined;
      return state.snapshot?.winnerNudgeGrants?.find((grant) => grant.roomId === roomId);
    }, [roomId]),
  );
}

export type ExpenseExceptionSummary = {
  reason: string;
  requestedBy: string;
  approvedCount: number;
  requiredCount: number;
  heldCount: number;
  responseByMe?: "APPROVED" | "HELD";
  /** 현재 사용자가 이 주차의 활성 멤버이며 제시자가 아니라 응답할 수 있는지. */
  canRespond: boolean;
  isRequester: boolean;
  isExcluded: boolean;
};

/** 지출 상세의 예외 승인 카드에 필요한 요약. 예외가 없으면 undefined. */

export function useExpenseExceptionSummary(
  expenseId: string | undefined,
): ExpenseExceptionSummary | undefined {
  const selector = useCallback(
    (state: AppStoreState): ExpenseExceptionSummary | undefined => {
      if (!expenseId) return undefined;
      const exception = state.indexes.exceptionByExpenseId.get(expenseId);
      const expense = state.indexes.expenseById.get(expenseId);
      if (!exception || !expense || !expense.periodId) return undefined;
      const currentUserId = state.snapshot?.currentUserId;
      const activeMembers = (
        state.indexes.membersByPeriodId.get(expense.periodId) ?? EMPTY_MEMBERS
      ).filter((member) => member.status === 'ACTIVE');
      const approvers = state.indexes.approvedUserIdsByExpenseId.get(expenseId) ?? EMPTY_APPROVERS;
      const held = state.indexes.heldUserIdsByExpenseId.get(expenseId) ?? EMPTY_APPROVERS;
      const eligibleMembers = activeMembers.filter(
        (member) => member.userId !== exception.requestedBy,
      );
      const responseByMe = currentUserId && approvers.has(currentUserId)
        ? "APPROVED"
        : currentUserId && held.has(currentUserId)
          ? "HELD"
          : undefined;
      return {
        reason: exception.reason,
        requestedBy: exception.requestedBy,
        approvedCount: eligibleMembers.filter((member) => approvers.has(member.userId)).length,
        requiredCount: eligibleMembers.length,
        heldCount: eligibleMembers.filter((member) => held.has(member.userId)).length,
        responseByMe,
        canRespond: currentUserId
          ? eligibleMembers.some((member) => member.userId === currentUserId)
          : false,
        isRequester: currentUserId === exception.requestedBy,
        isExcluded: state.indexes.settlementExcludedExpenseIds.has(expenseId),
      };
    },
    [expenseId],
  );
  return useAppStoreSelector(selector, expenseExceptionSummaryEqual);
}

export type PendingExceptionApproval = {
  expenseId: string;
  reason: string;
  requesterNickname: string;
  requesterAvatar: string;
  requesterAvatarUri?: string;
  amount: number;
  category: Expense['category'];
  approvedCount: number;
  requiredCount: number;
  responseByMe?: "HELD";
};

/** 현재 사용자가 아직 승인하지 않은, 응답 가능한 예외들(홈 대기함). */

export function usePendingExceptionApprovals(): PendingExceptionApproval[] {
  const selector = useCallback((state: AppStoreState): PendingExceptionApproval[] => {
    const snapshot = state.snapshot;
    const currentUserId = snapshot?.currentUserId;
    if (!snapshot || !currentUserId) return EMPTY_PENDING_APPROVALS;
    const pending: PendingExceptionApproval[] = [];
    for (const exception of snapshot.expenseExceptions) {
      if (state.indexes.settlementExcludedExpenseIds.has(exception.expenseId)) continue;
      const expense = state.indexes.expenseById.get(exception.expenseId);
      if (!expense || !expense.periodId) continue;
      const period = state.indexes.periodById.get(expense.periodId);
      // 승인은 C(보정 마감)까지만 열려 있다: ACTIVE/ADJUSTMENT 주차만 대상.
      if (!period || (period.phase !== 'ACTIVE' && period.phase !== 'ADJUSTMENT')) continue;
      const activeMembers = (
        state.indexes.membersByPeriodId.get(expense.periodId) ?? EMPTY_MEMBERS
      ).filter((member) => member.status === 'ACTIVE');
      const eligibleMembers = activeMembers.filter(
        (member) => member.userId !== exception.requestedBy,
      );
      if (!eligibleMembers.some((member) => member.userId === currentUserId)) continue;
      const approvers = state.indexes.approvedUserIdsByExpenseId.get(exception.expenseId) ?? EMPTY_APPROVERS;
      if (approvers.has(currentUserId)) continue;
      const held = state.indexes.heldUserIdsByExpenseId.get(exception.expenseId) ?? EMPTY_APPROVERS;
      const profile = state.indexes.profileById.get(exception.requestedBy);
      pending.push({
        expenseId: exception.expenseId,
        reason: exception.reason,
        requesterNickname: profile?.nickname ?? '알 수 없음',
        requesterAvatar: profile?.avatar ?? '',
        requesterAvatarUri: profile?.avatarUri,
        amount: expense.amount,
        category: expense.category,
        approvedCount: eligibleMembers.filter((member) => approvers.has(member.userId)).length,
        requiredCount: eligibleMembers.length,
        responseByMe: held.has(currentUserId) ? "HELD" : undefined,
      });
    }
    return pending.length ? pending : EMPTY_PENDING_APPROVALS;
  }, []);
  return useAppStoreSelector(selector, pendingExceptionApprovalsEqual);
}

function expenseExceptionSummaryEqual(
  left: ExpenseExceptionSummary | undefined,
  right: ExpenseExceptionSummary | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.reason === right.reason &&
    left.requestedBy === right.requestedBy &&
    left.approvedCount === right.approvedCount &&
    left.requiredCount === right.requiredCount &&
    left.heldCount === right.heldCount &&
    left.responseByMe === right.responseByMe &&
    left.canRespond === right.canRespond &&
    left.isRequester === right.isRequester &&
    left.isExcluded === right.isExcluded
  );
}

function pendingExceptionApprovalsEqual(
  left: readonly PendingExceptionApproval[],
  right: readonly PendingExceptionApproval[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const other = right[index];
    return (
      value.expenseId === other.expenseId &&
      value.reason === other.reason &&
      value.requesterNickname === other.requesterNickname &&
      value.requesterAvatar === other.requesterAvatar &&
      value.requesterAvatarUri === other.requesterAvatarUri &&
      value.amount === other.amount &&
      value.category === other.category &&
      value.approvedCount === other.approvedCount &&
      value.requiredCount === other.requiredCount &&
      value.responseByMe === other.responseByMe
    );
  });
}
