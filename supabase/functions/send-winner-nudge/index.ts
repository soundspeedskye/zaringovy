import "@supabase/functions-js/edge-runtime.d.ts";

import { withSupabase } from "@supabase/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isFcmToken,
  sendFcmMessages,
  type FcmTokenRow,
} from "../_shared/fcm.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestBody = { roomId?: unknown; body?: unknown };
type DeliveryToken = FcmTokenRow & { user_id: string };

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    const payload = await request.json().catch(() => null) as RequestBody | null;
    const roomId = payload?.roomId;
    const body = typeof payload?.body === "string" ? payload.body.trim() : "";
    const authorization = request.headers.get("authorization");
    const userId = typeof ctx.userClaims?.id === "string" ? ctx.userClaims.id : null;
    if (!userId || typeof roomId !== "string" || !uuidPattern.test(roomId) || !body || body.length > 80 || !authorization) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      const userClient = createClient(requiredEnv("SUPABASE_URL"), requiredAnonKey(), {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: authorization } },
      });
      const { data, error } = await userClient.rpc("send_winner_nudge", {
        p_room_id: roomId,
        p_body: body,
      });
      if (error || !data || typeof data !== "object") {
        return Response.json({ error: "winner_nudge_rejected" }, { status: 403 });
      }

      const recipients = parseRecipientIds(data);
      if (recipients.length === 0) return Response.json({ delivered: 0 });
      const [{ data: profile, error: profileError }, tokens] = await Promise.all([
        ctx.supabaseAdmin.from("profiles").select("nickname").eq("id", userId).single(),
        findActiveFcmTokens(ctx.supabaseAdmin, recipients),
      ]);
      if (profileError) throw profileError;
      const delivery = await sendFcmMessages(tokens, {
        title: "지난 주차 1위의 잔소리",
        body: profile.nickname + ": " + body,
        data: { route: "/notifications" },
      });
      if (delivery.invalidTokenIds.length) {
        const { error: disableError } = await ctx.supabaseAdmin
          .from("device_push_tokens")
          .update({ is_enabled: false })
          .in("id", delivery.invalidTokenIds);
        if (disableError) throw disableError;
      }
      return Response.json({
        delivered: delivery.acceptedCount,
        rejected: delivery.rejectedCount,
        disabled: delivery.invalidTokenIds.length,
      });
    } catch (error) {
      console.error("winner_nudge_delivery_failed", { type: errorName(error) });
      // The in-app notifications were committed before delivery. A push failure
      // must not make the user retry and generate duplicate inbox messages.
      return Response.json({ delivered: 0, pushPending: true });
    }
  }),
};

function parseRecipientIds(value: object): string[] {
  const ids = (value as { recipient_ids?: unknown }).recipient_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && uuidPattern.test(id)) : [];
}

async function findActiveFcmTokens(admin: SupabaseClient, userIds: string[]): Promise<DeliveryToken[]> {
  const { data, error } = await admin
    .from("device_push_tokens")
    .select("id,user_id,token")
    .eq("is_enabled", true)
    .in("platform", ["ios", "android"])
    .in("user_id", userIds);
  if (error) throw error;
  return ((data ?? []) as DeliveryToken[]).filter(({ token }) => isFcmToken(token));
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(name + " is not configured");
  return value;
}

function requiredAnonKey(): string {
  return Deno.env.get("SUPABASE_ANON_KEY")
    ?? (() => {
      const keys = JSON.parse(requiredEnv("SUPABASE_PUBLISHABLE_KEYS")) as Record<string, unknown>;
      if (typeof keys.default !== "string") throw new Error("publishable key unavailable");
      return keys.default;
    })();
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name.slice(0, 80)
    : "unknown";
}
