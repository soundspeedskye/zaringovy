import type { PropsWithChildren } from 'react';
import { createContext, useContext, useMemo } from 'react';

import type { AppRepository } from '@/shared/api/repository';
import type {
  AddExpenseInput,
  Expense,
  RoomMember,
} from '@/shared/api/types';
import { useAppStore } from '@/shared/providers/app-store-provider';
import { useAppExecution } from '@/shared/providers/app-status-provider';

/**
 * repository 메서드를 그대로 노출하되 execute()로 감싸 에러 보고를 붙이는 액션들.
 *
 * 이름을 여기 한 곳에만 적는다. 시그니처는 AppRepository에서 그대로 가져오고,
 * value 객체와 의존성 목록도 이 배열에서 만들어진다. satisfies가 오타와 사라진
 * 메서드를 컴파일 타임에 잡는다.
 */
const EXECUTED_ACTIONS = [
  'updateNickname',
  'updateAvatar',
  'createRoom',
  'updateRoomSettings',
  'previewInvite',
  'joinRoom',
  'leaveRoom',
  'closeRoom',
  'switchRoom',
  'addExpense',
  'respondToExpenseException',
  'withdrawExpenseException',
  'updateExpense',
  'deleteExpense',
  'deleteArchivedPeriod',
  'addComment',
  'updateComment',
  'deleteComment',
  'toggleCommentReaction',
  'addRoomPost',
  'updateRoomPost',
  'deleteRoomPost',
  'addRoomPostComment',
  'updateRoomPostComment',
  'deleteRoomPostComment',
  'toggleRoomPostReaction',
  'voteRoomPostPoll',
  'markNotificationsRead',
  'markAllNotificationsRead',
  'sendWinnerNudge',
] as const satisfies readonly (keyof AppRepository)[];

type ExecutedAction = (typeof EXECUTED_ACTIONS)[number];

type AnyAsyncFn = (...args: never[]) => Promise<unknown>;

export type AppActionsContextValue =
  & Omit<Pick<AppRepository, ExecutedAction>, 'joinRoom' | 'updateExpense'>
  & {
    /** joinedAt은 오프라인 큐가 재생할 때 쓰는 내부 인자라 화면에는 열지 않는다. */
    joinRoom: (inviteCode: string) => Promise<RoomMember>;
    /** expectedPhotoPath는 응답 유실 판정을 위한 큐 내부 인자라 화면에는 열지 않는다. */
    updateExpense: (expenseId: string, patch: Partial<AddExpenseInput>) => Promise<Expense>;
    /**
     * 읽음 처리는 사용자가 요청한 동작이 아니라 열람의 부수 효과다. 화면은 로컬
     * 표시를 즉시 반영하고, 서버 반영이 실패해도(오프라인 등) 에러 배너를 띄우지
     * 않는다. 다음 동기화에서 받은 스냅샷이 최종 상태다. execute를 쓰지 않는
     * 이유이기도 하다.
     */
    markExpenseRead: (expenseId: string) => void;
    markRoomPostRead: (postId: string) => void;
  };

const AppActionsContext = createContext<AppActionsContextValue | null>(null);

export function AppActionsProvider({
  children,
  repository,
}: PropsWithChildren<{ repository: AppRepository }>) {
  const { execute } = useAppExecution();
  const store = useAppStore();

  // execute·repository·store가 모두 안정적이라 액션 하나하나를 따로 메모할
  // 이유가 없다. 객체를 한 번만 만들면 그 안의 함수 참조도 함께 안정적이다.
  const value = useMemo<AppActionsContextValue>(() => {
    const executed = Object.fromEntries(
      EXECUTED_ACTIONS.map((name) => [
        name,
        (...args: never[]) => execute(() => (repository[name] as AnyAsyncFn)(...args)),
      ]),
    ) as Pick<AppRepository, ExecutedAction>;

    return {
      ...executed,
      markExpenseRead: (expenseId) => {
        const { indexes, localReads } = store.getState();
        // 이미 읽은 항목이면 서버에 알릴 것도 없다. 이 가드가 없으면 상세를
        // 열 때마다 RPC가 나가고, 그때마다 스냅샷 갱신이 뒤따른다.
        if (indexes.readExpenseIds.has(expenseId)) return;
        if (localReads.expenseIds.has(expenseId)) return;
        store.markReadLocally('expense', expenseId);
        void repository.markExpenseRead(expenseId).catch(() => undefined);
      },
      markRoomPostRead: (postId) => {
        const { indexes, localReads } = store.getState();
        if (indexes.readPostIds.has(postId)) return;
        if (localReads.postIds.has(postId)) return;
        store.markReadLocally('post', postId);
        void repository.markRoomPostRead(postId).catch(() => undefined);
      },
    };
  }, [execute, repository, store]);

  return <AppActionsContext.Provider value={value}>{children}</AppActionsContext.Provider>;
}

export function useAppActions(): AppActionsContextValue {
  const context = useContext(AppActionsContext);
  if (!context) throw new Error('useAppActions must be used inside AppActionsProvider');
  return context;
}
