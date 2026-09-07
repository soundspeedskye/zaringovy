import type { Session } from "@supabase/supabase-js";
import * as Linking from "expo-linking";
import type { PropsWithChildren } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getRepositoryRuntime } from "@/shared/api/repository-factory";
import { getSupabaseClient } from "@/shared/api/supabase-client";
import { authErrorMessage } from "@/shared/lib/auth-error";
import {
  parseRecoveryAuthLink,
  recoveryLinkError,
} from "@/shared/lib/auth-link";
import { disableCurrentPushNotificationsForUser } from "@/shared/services/push-notifications";

type SessionContextValue = {
  loading: boolean;
  recoveryMode: boolean;
  accountSafetyNotice: string | null;
  session: Session | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    email: string,
    password: string,
    nickname: string,
  ) => Promise<"SIGNED_IN" | "CONFIRM_EMAIL">;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  deleteAccount: (currentPassword: string) => Promise<void>;
  completeRecovery: () => void;
  signOut: () => Promise<void>;
};

/**
 * 계정 전환 허가가 유효한 시간. 허가는 요청을 보내기 전에 열리므로 네트워크
 * 왕복을 덮을 만큼 넉넉해야 하고(짧으면 느린 회선에서 정상 로그인이 거부된다),
 * 그 행동과 무관해질 만큼은 짧아야 한다.
 */
const ACCOUNT_CHANGE_GRACE_MS = 30_000;

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const runtime = getRepositoryRuntime();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [accountSafetyNotice, setAccountSafetyNotice] = useState<string | null>(
    null,
  );
  // 런타임 중 다른 계정의 세션이 들어오는 경우(Expo 재시작·딥링크·저장소
  // 경합 포함)를 명시적인 로그인/복구 흐름과 구분한다.
  const activeUserIdRef = useRef<string | null>(null);
  // 계정 전환 허가는 "방금 사용자가 한 행동"에만 붙으므로 시간으로 묶는다.
  // 불리언으로 두면 실제 전환이 일어날 때만 회수돼, 로그아웃 상태에서 로그인한
  // 뒤에는(전환이 아니라 신규 세션이라 회수 지점을 지나가지 않는다) 앱이 도는
  // 내내 가드가 풀린 채로 남았다.
  const accountChangeAllowedUntilRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let bootstrapComplete = false;
    const client = getSupabaseClient();
    runtime.setActiveUserId(null);
    const applySession = (event: string, nextSession: Session | null) => {
      if (cancelled) return;
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
      runtime.setActiveUserId(nextSession?.user.id ?? null);
      activeUserIdRef.current = nextSession?.user.id ?? null;
      setSession(nextSession);
      setLoading(false);
    };
    const signOutForUnexpectedAuthLink = async () => {
      // 인증 링크의 계정이 현재 계정과 다르면 링크 세션을 적용하지 않는다.
      // 사용자가 원하지 않은 계정 전환보다 로그인 화면으로 돌아가는 편이 안전하다.
      try {
        await client.auth.signOut({ scope: "local" });
      } finally {
        // 로컬 저장소 정리가 실패해도 UI와 오프라인 데이터 계층은 즉시 비인증
        // 상태로 전환해 다른 계정의 기록을 계속 보이지 않게 한다.
        applySession("AUTH_LINK_ACCOUNT_MISMATCH", null);
        setAccountSafetyNotice("연결을 다시 확인해주세요.");
        setRecoveryMode(false);
      }
    };
    const applyAuthUrl = async (url: string | null) => {
      if (!url) return;
      const link = parseRecoveryAuthLink(url, Linking.parse(url));
      if (!link) return;
      if (link.kind === "REJECTED") {
        setRecoveryMode(false);
        setAccountSafetyNotice(recoveryLinkError(link.code));
        return;
      }

      // 검증이 끝나기 전에 복구 모드를 연다. 딥링크가 이미 새 비밀번호 화면으로
      // 이동시킨 뒤라, 이 값이 늦게 켜지면 아래 getUser를 기다리는 동안 라우팅
      // 가드가 화면을 로그인으로 되돌려 정상 링크가 끊긴다. 이 값 자체는 어떤
      // 권한도 주지 않고 화면을 어디 둘지만 정한다.
      setRecoveryMode(true);

      // setSession 전에 서버에서 토큰의 실제 사용자 ID를 확인한다. URL fragment는
      // 어떤 앱 링크에도 붙을 수 있으므로, 토큰 존재만으로 세션을 바꾸면 안 된다.
      const { data, error } = await client.auth.getUser(link.accessToken);
      if (error || !data.user) {
        // 4xx는 서버가 토큰을 거절한 것이고, 그 밖(네트워크 실패 등)은 링크가
        // 멀쩡한데 확인을 못 한 상황이라 사용자가 할 일이 다르다.
        const rejected = typeof error?.status === "number" && error.status < 500;
        setRecoveryMode(false);
        setAccountSafetyNotice(
          rejected
            ? recoveryLinkError("otp_expired")
            : "연결을 확인한 뒤 링크를 다시 눌러 주세요.",
        );
        return;
      }
      const currentResult = await client.auth.getSession();
      if (currentResult.error) throw currentResult.error;
      const currentUserId = currentResult.data.session?.user.id;
      if (currentUserId && currentUserId !== data.user.id) {
        await signOutForUnexpectedAuthLink();
        return;
      }

      setAccountSafetyNotice(null);
      accountChangeAllowedUntilRef.current = Date.now() + ACCOUNT_CHANGE_GRACE_MS;
      await client.auth.setSession({
        access_token: link.accessToken,
        refresh_token: link.refreshToken,
      });
    };
    const authSubscription = client.auth.onAuthStateChange(
      (event, nextSession) => {
        // The initial URL may replace the persisted session. During bootstrap we
        // select the final session explicitly below; applying INITIAL_SESSION
        // here could replay the previous account's native offline queue first.
        if (cancelled || !bootstrapComplete || event === "INITIAL_SESSION")
          return;
        const currentUserId = activeUserIdRef.current;
        const nextUserId = nextSession?.user.id ?? null;
        const accountChanged = Boolean(
          currentUserId && nextUserId && currentUserId !== nextUserId,
        );
        if (accountChanged && Date.now() >= accountChangeAllowedUntilRef.current) {
          void signOutForUnexpectedAuthLink();
          return;
        }
        // 허가가 만료를 기다리지 않고 쓰이자마자 닫히도록 창을 더 좁힌다.
        if (accountChanged) accountChangeAllowedUntilRef.current = 0;
        applySession(event, nextSession);
      },
    ).data.subscription;
    const linkSubscription = Linking.addEventListener("url", ({ url }) => {
      void applyAuthUrl(url).catch(() => undefined);
    });
    void Promise.all([client.auth.getSession(), Linking.getInitialURL()])
      .then(async ([sessionResult, initialUrl]) => {
        if (sessionResult.error) throw sessionResult.error;
        await applyAuthUrl(initialUrl);
        const current = await client.auth.getSession();
        if (current.error) throw current.error;
        if (!cancelled) applySession("BOOTSTRAP", current.data.session);
      })
      .catch(() => {
        if (!cancelled) applySession("BOOTSTRAP", null);
      })
      .finally(() => {
        bootstrapComplete = true;
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      authSubscription.unsubscribe();
      linkSubscription.remove();
    };
  }, [runtime]);

  const signIn = useCallback(async (email: string, password: string) => {
    validateEmail(email);
    validatePassword(password);
    accountChangeAllowedUntilRef.current = Date.now() + ACCOUNT_CHANGE_GRACE_MS;
    setAccountSafetyNotice(null);
    const { error } = await getSupabaseClient().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) accountChangeAllowedUntilRef.current = 0;
    if (error) throw new Error(authErrorMessage(error, "SIGN_IN"));
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, nickname: string) => {
      validateEmail(email);
      validatePassword(password);
      const cleanNickname = nickname.trim();
      if (cleanNickname.length < 2 || cleanNickname.length > 20) {
        throw new Error(
          "닉네임은 앞뒤 공백을 제외하고 2~20자로 입력해 주세요.",
        );
      }
      accountChangeAllowedUntilRef.current = Date.now() + ACCOUNT_CHANGE_GRACE_MS;
      setAccountSafetyNotice(null);
      const { data, error } = await getSupabaseClient().auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { nickname: cleanNickname },
          emailRedirectTo: Linking.createURL("/"),
        },
      });
      if (error) {
        accountChangeAllowedUntilRef.current = 0;
        throw new Error(authErrorMessage(error, "SIGN_UP"));
      }
      if (!data.session) accountChangeAllowedUntilRef.current = 0;
      return data.session ? "SIGNED_IN" : "CONFIRM_EMAIL";
    },
    [],
  );

  const requestPasswordReset = useCallback(async (email: string) => {
    validateEmail(email);
    // 새 링크를 요청한 순간 이전 링크에 대한 안내는 더 이상 맞지 않는다.
    setAccountSafetyNotice(null);
    const { error } = await getSupabaseClient().auth.resetPasswordForEmail(
      email.trim(),
      {
        redirectTo: Linking.createURL("/reset-password"),
      },
    );
    if (error) throw new Error(authErrorMessage(error, "RESET_REQUEST"));
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    validatePassword(password);
    const { error } = await getSupabaseClient().auth.updateUser({ password });
    if (error) throw new Error(authErrorMessage(error, "PASSWORD_UPDATE"));
    setRecoveryMode(false);
  }, []);

  const deleteAccount = useCallback(async (currentPassword: string) => {
    if (!currentPassword) throw new Error("현재 비밀번호를 입력해 주세요.");
    const currentUserId = session?.user.id;
    if (!currentUserId) throw new Error("로그인 정보를 다시 확인해 주세요.");

    const { data, error } = await getSupabaseClient().functions.invoke(
      "delete-account",
      { body: { password: currentPassword } },
    );
    if (error || !data || typeof data !== "object" || data.deleted !== true) {
      throw await accountDeletionError(error, data);
    }

    // The server has already invalidated this account. Clear the device's
    // offline queue and snapshots before switching the navigation gate off.
    await getRepositoryRuntime().clearDeletedUserData(currentUserId);
    try {
      await getSupabaseClient().auth.signOut({ scope: "local" });
    } finally {
      getRepositoryRuntime().setActiveUserId(null);
      activeUserIdRef.current = null;
      accountChangeAllowedUntilRef.current = 0;
      setRecoveryMode(false);
      setSession(null);
    }
  }, [session?.user.id]);

  const signOut = useCallback(async () => {
    const userId = session?.user.id;
    // 현재 기기만 끄므로 다른 기기에서 로그인 중인 사용자의 알림에는 영향을 주지
    // 않는다. 토큰 정리 실패는 로그아웃을 막을 정도로 치명적이지 않다.
    if (userId) {
      await disableCurrentPushNotificationsForUser(userId).catch(() => undefined);
    }
    const { error } = await getSupabaseClient().auth.signOut({
      scope: "local",
    });
    if (error) throw new Error(authErrorMessage(error, "SIGN_OUT"));
    getRepositoryRuntime().setActiveUserId(null);
    activeUserIdRef.current = null;
    accountChangeAllowedUntilRef.current = 0;
    setRecoveryMode(false);
  }, [session?.user.id]);

  const value = useMemo<SessionContextValue>(
    () => ({
      loading,
      recoveryMode,
      accountSafetyNotice,
      session,
      signIn,
      signUp,
      requestPasswordReset,
      updatePassword,
      deleteAccount,
      completeRecovery: () => setRecoveryMode(false),
      signOut,
    }),
    [
      accountSafetyNotice,
      loading,
      recoveryMode,
      requestPasswordReset,
      session,
      signIn,
      signOut,
      signUp,
      updatePassword,
      deleteAccount,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context)
    throw new Error("useSession must be used inside SessionProvider");
  return context;
}

function validateEmail(value: string): void {
  if (!/^\S+@\S+\.\S+$/u.test(value.trim()))
    throw new Error("이메일 주소를 확인해 주세요.");
}

function validatePassword(value: string): void {
  if (value.length < 8) throw new Error("비밀번호는 8자 이상이어야 해요.");
}

async function accountDeletionError(error: unknown, data: unknown): Promise<Error> {
  let responseData = data;
  const context = error && typeof error === "object"
    ? (error as { context?: unknown }).context
    : null;
  if (!responseData && context instanceof Response) {
    responseData = await context.clone().json().catch(() => null);
  }
  const payload = responseData && typeof responseData === "object"
    ? responseData as { error?: unknown }
    : null;
  const code = typeof payload?.error === "string" ? payload.error : "";
  if (code === "invalid_password") return new Error("현재 비밀번호가 맞지 않아요.");
  if (code === "invalid_request") return new Error("현재 비밀번호를 다시 입력해 주세요.");
  if (error instanceof Error && /invalid_password/iu.test(error.message)) {
    return new Error("현재 비밀번호가 맞지 않아요.");
  }
  return new Error("계정을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.");
}
