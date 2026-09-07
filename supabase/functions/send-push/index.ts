import "@supabase/functions-js/edge-runtime.d.ts";

import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

const expoPushEndpoint = "https://exp.host/--/api/v2/push/send";
const expoPushBatchSize = 100;
const tokenPageSize = 1000;
const expoPushTokenPattern = /^ExponentPushToken\[[^\]]+\]$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SendPushRequest = {
  audience?: unknown;
  userId?: unknown;
  title?: unknown;
  body?: unknown;
  data?: unknown;
};

type ValidPushRequest = {
  audience: "all" | "user";
  userId?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
};

type PushTokenRow = { id: string; token: string };
type ExpoPushTicket = {
  status?: unknown;
  id?: unknown;
  details?: { error?: unknown } | null;
};

/**
 * Internal delivery endpoint. A project secret key is required, so mobile clients
 * cannot invoke this Function to target another user or broadcast to every user.
 */
export default {
  fetch: withSupabase({ auth: "secret" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    const payload = await request.json().catch(() => null) as SendPushRequest | null;
    const parsed = parseRequest(payload);
    if (!parsed.ok) {
      return Response.json({ error: "invalid_request", reason: parsed.reason }, { status: 400 });
    }

    try {
      const tokens = await findActiveExpoTokens(ctx.supabaseAdmin, parsed.value);
      const delivery = await sendExpoMessages(tokens, parsed.value);

      if (delivery.invalidTokenIds.length > 0) {
        const { error } = await ctx.supabaseAdmin
          .from("device_push_tokens")
          .update({ is_enabled: false })
          .in("id", delivery.invalidTokenIds);
        if (error) throw error;
      }

      console.log("push_delivery_completed", {
        audience: parsed.value.audience,
        targetCount: tokens.length,
        acceptedCount: delivery.ticketIds.length,
        rejectedCount: delivery.rejectedCount,
        disabledCount: delivery.invalidTokenIds.length,
      });

      return Response.json({
        attempted: tokens.length,
        accepted: delivery.ticketIds.length,
        rejected: delivery.rejectedCount,
        disabled: delivery.invalidTokenIds.length,
        ticketIds: delivery.ticketIds,
      });
    } catch (error) {
      console.error("push_delivery_failed", { type: errorName(error) });
      return Response.json({ error: "push_delivery_failed" }, { status: 502 });
    }
  }),
};

function parseRequest(payload: SendPushRequest | null):
  | { ok: true; value: ValidPushRequest }
  | { ok: false; reason: string } {
  if (!payload || (payload.audience !== "all" && payload.audience !== "user")) {
    return { ok: false, reason: "invalid_audience" };
  }
  if (typeof payload.title !== "string" || payload.title.length === 0 || payload.title.length > 120) {
    return { ok: false, reason: "invalid_title" };
  }
  if (typeof payload.body !== "string" || payload.body.length === 0 || payload.body.length > 500) {
    return { ok: false, reason: "invalid_body" };
  }
  if (payload.audience === "user" && (typeof payload.userId !== "string" || !uuidPattern.test(payload.userId))) {
    return { ok: false, reason: "invalid_user_id" };
  }

  const data = parseNotificationData(payload.data);
  if (!data.ok) return data;

  return {
    ok: true,
    value: {
      audience: payload.audience,
      ...(payload.audience === "user" ? { userId: payload.userId as string } : {}),
      title: payload.title,
      body: payload.body,
      ...(data.value ? { data: data.value } : {}),
    },
  };
}

function parseNotificationData(value: unknown):
  | { ok: true; value?: Record<string, string> }
  | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid_data" };
  }

  const entries = Object.entries(value);
  if (entries.some(([key, item]) => (key !== "route" && key !== "commentId") || typeof item !== "string")) {
    return { ok: false, reason: "invalid_data" };
  }

  const data = Object.fromEntries(entries) as Record<string, string>;
  if (data.route && !isSupportedRoute(data.route)) {
    return { ok: false, reason: "unsupported_route" };
  }
  if (data.commentId && !data.route?.startsWith("/expense/")) {
    return { ok: false, reason: "invalid_comment_id" };
  }

  return { ok: true, ...(entries.length > 0 ? { value: data } : {}) };
}

function isSupportedRoute(route: string): boolean {
  return route === "/notifications"
    || /^\/expense\/[^/]+$/.test(route)
    || /^\/community\/[^/]+$/.test(route);
}

async function findActiveExpoTokens(
  admin: SupabaseClient,
  request: ValidPushRequest,
): Promise<PushTokenRow[]> {
  const rows: PushTokenRow[] = [];
  let from = 0;

  while (true) {
    let query = admin
      .from("device_push_tokens")
      .select("id, token")
      .eq("is_enabled", true)
      .like("token", "ExponentPushToken[%]")
      .range(from, from + tokenPageSize - 1);
    if (request.audience === "user") query = query.eq("user_id", request.userId!);

    const { data, error } = await query;
    if (error) throw error;

    const page = (data ?? []) as PushTokenRow[];
    rows.push(...page.filter(({ token }) => expoPushTokenPattern.test(token)));
    if (page.length < tokenPageSize) return rows;
    from += tokenPageSize;
  }
}

async function sendExpoMessages(tokens: PushTokenRow[], request: ValidPushRequest): Promise<{
  ticketIds: string[];
  invalidTokenIds: string[];
  rejectedCount: number;
}> {
  const ticketIds: string[] = [];
  const invalidTokenIds: string[] = [];
  let rejectedCount = 0;

  for (let index = 0; index < tokens.length; index += expoPushBatchSize) {
    const batch = tokens.slice(index, index + expoPushBatchSize);
    const response = await fetch(expoPushEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(batch.map(({ token }) => ({
        to: token,
        sound: "default",
        title: request.title,
        body: request.body,
        ...(request.data ? { data: request.data } : {}),
      }))),
    });
    if (!response.ok) throw new Error(`expo_push_http_${response.status}`);

    const body = await response.json() as { data?: unknown };
    if (!Array.isArray(body.data) || body.data.length !== batch.length) {
      throw new Error("invalid_expo_push_response");
    }

    for (const [ticketIndex, rawTicket] of body.data.entries()) {
      const ticket = rawTicket as ExpoPushTicket;
      if (ticket.status === "ok" && typeof ticket.id === "string") {
        ticketIds.push(ticket.id);
        continue;
      }

      rejectedCount += 1;
      if (ticket.details?.error === "DeviceNotRegistered" && batch[ticketIndex]) {
        invalidTokenIds.push(batch[ticketIndex].id);
      }
    }
  }

  return { ticketIds, invalidTokenIds, rejectedCount };
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object" || typeof (error as { name?: unknown }).name !== "string") {
    return "unknown";
  }
  return (error as { name: string }).name.slice(0, 80);
}

/* To invoke from an internal service or cron job:

  curl --request POST 'https://PROJECT_REF.supabase.co/functions/v1/send-push' \
    --header 'apikey: sb_secret_...' \
    --header 'content-type: application/json' \
    --data '{
      "audience": "user",
      "userId": "00000000-0000-4000-8000-000000000000",
      "title": "테스트 알림",
      "body": "푸시 수신을 확인해 주세요.",
      "data": { "route": "/notifications" }
    }'

*/
