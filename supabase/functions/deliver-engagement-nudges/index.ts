import "@supabase/functions-js/edge-runtime.d.ts";

import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isFcmToken,
  sendFcmMessages,
  type FcmTokenRow,
} from "../_shared/fcm.ts";

type NudgeEvent = {
  id: string;
  user_id: string;
  reason: "inactive" | "no_post";
  reference_at: string;
};

type PushToken = FcmTokenRow & { user_id: string };
type EngagementMessage = PushToken & {
  eventId: string;
  title: string;
  body: string;
};

/** Cron이 만든 리마인더 큐를 가져와 FCM HTTP v1로 전달하는 내부 worker. */
export default {
  fetch: withSupabase({ auth: "secret" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    let claimed: NudgeEvent[] = [];
    try {
      claimed = await claimEvents(ctx.supabaseAdmin);
      if (claimed.length === 0) {
        return Response.json({ claimed: 0, attempted: 0, accepted: 0, rejected: 0, disabled: 0 });
      }

      const tokens = await findActiveFcmTokens(
        ctx.supabaseAdmin,
        [...new Set(claimed.map((event) => event.user_id))],
      );
      const messages: EngagementMessage[] = claimed.flatMap((event) => {
        const copy = nudgeCopy(event.reason);
        return tokens
          .filter((token) => token.user_id === event.user_id)
          .map((token) => ({
            ...token,
            eventId: event.id,
            ...copy,
          }));
      });
      const attemptedEventIds = new Set(messages.map((message) => message.eventId));
      const delivery = await sendFcmMessages(messages, (message) => ({
        title: message.title,
        body: message.body,
        data: { route: "/" },
      }));

      if (delivery.invalidTokenIds.length > 0) {
        const { error } = await ctx.supabaseAdmin
          .from("device_push_tokens")
          .update({ is_enabled: false })
          .in("id", delivery.invalidTokenIds);
        // FCM 요청이 성공한 뒤 토큰 정리만 일시적으로 실패해도 리마인더는 성공 처리한다.
        if (error) console.error("engagement_nudge_token_cleanup_failed", { type: errorName(error) });
      }

      await completeEvents(ctx.supabaseAdmin, claimed, attemptedEventIds);
      console.log("engagement_nudge_delivery_completed", {
        claimed: claimed.length,
        attempted: messages.length,
        accepted: delivery.acceptedCount,
        rejected: delivery.rejectedCount,
        disabled: delivery.invalidTokenIds.length,
      });

      return Response.json({
        claimed: claimed.length,
        attempted: messages.length,
        accepted: delivery.acceptedCount,
        rejected: delivery.rejectedCount,
        disabled: delivery.invalidTokenIds.length,
      });
    } catch (error) {
      await Promise.allSettled(
        claimed.map((event) => completeEvent(
          ctx.supabaseAdmin,
          event.id,
          "failed",
          errorName(error),
        )),
      );
      console.error("engagement_nudge_delivery_failed", { type: errorName(error) });
      return Response.json({ error: "push_delivery_failed" }, { status: 502 });
    }
  }),
};

async function claimEvents(admin: SupabaseClient): Promise<NudgeEvent[]> {
  const { data, error } = await admin.rpc("claim_engagement_nudge_events", { p_limit: 100 });
  if (error) throw error;
  return (data ?? []) as NudgeEvent[];
}

async function findActiveFcmTokens(admin: SupabaseClient, userIds: string[]): Promise<PushToken[]> {
  const { data, error } = await admin
    .from("device_push_tokens")
    .select("id,user_id,token")
    .eq("is_enabled", true)
    .in("platform", ["ios", "android"])
    .in("user_id", userIds);
  if (error) throw error;
  return ((data ?? []) as PushToken[]).filter(({ token }) => isFcmToken(token));
}

async function completeEvents(
  admin: SupabaseClient,
  events: NudgeEvent[],
  attemptedEventIds: Set<string>,
): Promise<void> {
  const results = await Promise.allSettled(
    events.map((event) => completeEvent(
      admin,
      event.id,
      attemptedEventIds.has(event.id) ? "sent" : "failed",
      attemptedEventIds.has(event.id) ? undefined : "no_active_token",
    )),
  );
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function completeEvent(
  admin: SupabaseClient,
  eventId: string,
  status: "sent" | "failed",
  error?: string,
): Promise<void> {
  const { error: completionError } = await admin.rpc("complete_engagement_nudge_event", {
    p_event_id: eventId,
    p_status: status,
    p_error: error ?? null,
  });
  if (completionError) throw completionError;
}

function nudgeCopy(reason: NudgeEvent["reason"]): { title: string; body: string } {
  return reason === "no_post"
    ? {
      title: "오늘 한 줄 남겨볼까요?",
      body: "방에 글을 남기고 이번 주 기록을 이어가 보세요.",
    }
    : {
      title: "다시 만나요",
      body: "24시간 동안 앱에 들르지 않았어요. 오늘의 기록을 확인해 보세요.",
    };
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object" || typeof (error as { name?: unknown }).name !== "string") {
    return "unknown";
  }
  return (error as { name: string }).name.slice(0, 80);
}
