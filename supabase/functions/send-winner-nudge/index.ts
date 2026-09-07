import "@supabase/functions-js/edge-runtime.d.ts";

import { withSupabase } from "@supabase/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

const expoPushEndpoint = "https://exp.host/--/api/v2/push/send";
const expoPushBatchSize = 100;
const expoPushTokenPattern = /^ExponentPushToken\[[^\]]+\]$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestBody = { roomId?: unknown; body?: unknown };
type DeliveryToken = { id: string; user_id: string; token: string };
type Ticket = { status?: unknown; details?: { error?: unknown } | null };

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
        findActiveExpoTokens(ctx.supabaseAdmin, recipients),
      ]);
      if (profileError) throw profileError;
      const invalidTokenIds = await sendExpoMessages(tokens, `지난 주차 1위의 잔소리`, `${profile.nickname}: ${body}`);
      if (invalidTokenIds.length) {
        const { error: disableError } = await ctx.supabaseAdmin
          .from("device_push_tokens")
          .update({ is_enabled: false })
          .in("id", invalidTokenIds);
        if (disableError) throw disableError;
      }
      return Response.json({ delivered: tokens.length, disabled: invalidTokenIds.length });
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

async function findActiveExpoTokens(admin: SupabaseClient, userIds: string[]): Promise<DeliveryToken[]> {
  const { data, error } = await admin
    .from("device_push_tokens")
    .select("id,user_id,token")
    .eq("is_enabled", true)
    .like("token", "ExponentPushToken[%]")
    .in("user_id", userIds);
  if (error) throw error;
  return ((data ?? []) as DeliveryToken[]).filter((row) => expoPushTokenPattern.test(row.token));
}

async function sendExpoMessages(tokens: DeliveryToken[], title: string, body: string): Promise<string[]> {
  const invalidTokenIds: string[] = [];
  for (let index = 0; index < tokens.length; index += expoPushBatchSize) {
    const batch = tokens.slice(index, index + expoPushBatchSize);
    const response = await fetch(expoPushEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(batch.map(({ token }) => ({ to: token, sound: "default", title, body, data: { route: "/notifications" } }))),
    });
    if (!response.ok) throw new Error(`expo_push_http_${response.status}`);
    const payload = await response.json() as { data?: unknown };
    if (!Array.isArray(payload.data) || payload.data.length !== batch.length) throw new Error("invalid_expo_response");
    payload.data.forEach((raw, ticketIndex) => {
      const ticket = raw as Ticket;
      if (ticket.status !== "ok" && ticket.details?.error === "DeviceNotRegistered") invalidTokenIds.push(batch[ticketIndex].id);
    });
  }
  return invalidTokenIds;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
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
