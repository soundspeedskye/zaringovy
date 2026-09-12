import "@supabase/functions-js/edge-runtime.d.ts";

import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isFcmToken,
  sendFcmMessages,
  type FcmTokenRow,
} from "../_shared/fcm.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestBody = { notificationId?: unknown };

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
        findActiveFcmTokens(admin, notification.user_id),
      ]);
      if (postError) throw postError;
      if (!post || post.deleted_at) return Response.json({ skipped: true });

      const title = typeof post.title === "string" && post.title.trim()
        ? "공지: " + post.title.trim().slice(0, 100)
        : "새 공지";
      const delivery = await sendFcmMessages(tokens, {
        title,
        body: post.body,
        data: { route: "/community/" + post.id },
      });
      if (delivery.invalidTokenIds.length) {
        const { error } = await admin
          .from("device_push_tokens")
          .update({ is_enabled: false })
          .in("id", delivery.invalidTokenIds);
        if (error) throw error;
      }
      return Response.json({
        attempted: tokens.length,
        delivered: delivery.acceptedCount,
        rejected: delivery.rejectedCount,
        disabled: delivery.invalidTokenIds.length,
      });
    } catch (error) {
      console.error("room_notice_push_delivery_failed", { type: errorName(error) });
      return Response.json({ error: "push_delivery_failed" }, { status: 502 });
    }
  }),
};

async function findActiveFcmTokens(admin: SupabaseClient, userId: string): Promise<FcmTokenRow[]> {
  const { data, error } = await admin
    .from("device_push_tokens")
    .select("id,token")
    .eq("user_id", userId)
    .eq("is_enabled", true)
    .in("platform", ["ios", "android"]);
  if (error) throw error;
  return ((data ?? []) as FcmTokenRow[]).filter(({ token }) => isFcmToken(token));
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name.slice(0, 80)
    : "unknown";
}
