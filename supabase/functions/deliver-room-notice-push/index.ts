import "@supabase/functions-js/edge-runtime.d.ts";

import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

const expoPushEndpoint = "https://exp.host/--/api/v2/push/send";
const expoPushBatchSize = 100;
const expoPushTokenPattern = /^ExponentPushToken\[[^\]]+\]$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestBody = { notificationId?: unknown };
type PushToken = { id: string; token: string };
type ExpoTicket = { status?: unknown; details?: { error?: unknown } | null };

export default {
  fetch: withSupabase({ auth: "secret" }, async (request, ctx) => {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });

    const payload = await request.json().catch(() => null) as RequestBody | null;
    const notificationId = payload?.notificationId;
    if (typeof notificationId !== "string" || !uuidPattern.test(notificationId)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      const admin = ctx.supabaseAdmin;
      const { data: notification, error: notificationError } = await admin
        .from("notifications")
        .select("id,user_id,kind,post_id")
        .eq("id", notificationId)
        .maybeSingle();
      if (notificationError) throw notificationError;
      if (!notification || notification.kind !== "room_notice" || !notification.post_id) {
        return Response.json({ skipped: true });
      }

      const [{ data: post, error: postError }, tokens] = await Promise.all([
        admin
          .from("room_posts")
          .select("id,title,body,deleted_at")
          .eq("id", notification.post_id)
          .maybeSingle(),
        findActiveExpoTokens(admin, notification.user_id),
      ]);
      if (postError) throw postError;
      if (!post || post.deleted_at) return Response.json({ skipped: true });

      const title = typeof post.title === "string" && post.title.trim()
        ? `공지: ${post.title.trim().slice(0, 100)}`
        : "새 공지";
      const invalidTokenIds = await sendExpoMessages(tokens, title, post.body, `/community/${post.id}`);
      if (invalidTokenIds.length) {
        const { error } = await admin
          .from("device_push_tokens")
          .update({ is_enabled: false })
          .in("id", invalidTokenIds);
        if (error) throw error;
      }
      return Response.json({ delivered: tokens.length, disabled: invalidTokenIds.length });
    } catch (error) {
      console.error("room_notice_push_delivery_failed", { type: errorName(error) });
      return Response.json({ error: "push_delivery_failed" }, { status: 502 });
    }
  }),
};

async function findActiveExpoTokens(admin: SupabaseClient, userId: string): Promise<PushToken[]> {
  const { data, error } = await admin
    .from("device_push_tokens")
    .select("id,token")
    .eq("user_id", userId)
    .eq("is_enabled", true)
    .like("token", "ExponentPushToken[%]");
  if (error) throw error;
  return ((data ?? []) as PushToken[]).filter(({ token }) => expoPushTokenPattern.test(token));
}

async function sendExpoMessages(tokens: PushToken[], title: string, body: string, route: string): Promise<string[]> {
  const invalidTokenIds: string[] = [];
  for (let index = 0; index < tokens.length; index += expoPushBatchSize) {
    const batch = tokens.slice(index, index + expoPushBatchSize);
    const response = await fetch(expoPushEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(batch.map(({ token }) => ({
        to: token,
        sound: "default",
        title,
        body,
        data: { route },
      }))),
    });
    if (!response.ok) throw new Error(`expo_push_http_${response.status}`);
    const payload = await response.json() as { data?: unknown };
    if (!Array.isArray(payload.data) || payload.data.length !== batch.length) throw new Error("invalid_expo_response");
    payload.data.forEach((raw, ticketIndex) => {
      const ticket = raw as ExpoTicket;
      if (ticket.status !== "ok" && ticket.details?.error === "DeviceNotRegistered") {
        invalidTokenIds.push(batch[ticketIndex].id);
      }
    });
  }
  return invalidTokenIds;
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name.slice(0, 80)
    : "unknown";
}
