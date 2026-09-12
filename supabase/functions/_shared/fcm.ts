import "@supabase/functions-js/edge-runtime.d.ts";

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging";
const defaultTokenUri = "https://oauth2.googleapis.com/token";
const fcmBatchSize = 20;
const accessTokenSkewMs = 60_000;

export type FcmTokenRow = {
  id: string;
  token: string;
  user_id?: string;
};

export type FcmNotification = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export type FcmDelivery = {
  acceptedCount: number;
  rejectedCount: number;
  invalidTokenIds: string[];
  messageNames: string[];
};

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
};

type FcmApiResponse = {
  name?: unknown;
  error?: {
    status?: unknown;
    message?: unknown;
    details?: unknown;
  };
};

type CachedAccessToken = {
  value: string;
  expiresAt: number;
};

let cachedAccessToken: CachedAccessToken | null = null;

/** DB에 남아 있는 옛 Expo 토큰이 FCM 발송 대상으로 섞이지 않게 한다. */
export function isFcmToken(token: string): boolean {
  return token.length >= 16
    && token.length <= 4096
    && !/\s/.test(token)
    && !token.startsWith("ExponentPushToken[");
}

/**
 * FCM HTTP v1은 토큰별 단건 요청을 사용한다. 한 토큰의 영구 실패만 비활성화하고,
 * 인증·프로젝트·네트워크 오류는 전체 작업 실패로 반환해 재시도를 유도한다.
 */
export async function sendFcmMessages<T extends FcmTokenRow>(
  tokens: T[],
  notification: FcmNotification | ((token: T) => FcmNotification),
): Promise<FcmDelivery> {
  if (tokens.length === 0) {
    return {
      acceptedCount: 0,
      rejectedCount: 0,
      invalidTokenIds: [],
      messageNames: [],
    };
  }

  const accessToken = await getAccessToken();
  const result: FcmDelivery = {
    acceptedCount: 0,
    rejectedCount: 0,
    invalidTokenIds: [],
    messageNames: [],
  };

  for (let index = 0; index < tokens.length; index += fcmBatchSize) {
    const batch = tokens.slice(index, index + fcmBatchSize);
    const outcomes = await Promise.all(
      batch.map((token) => sendFcmMessage(
        accessToken,
        token.token,
        typeof notification === "function" ? notification(token) : notification,
      )),
    );

    outcomes.forEach((outcome, outcomeIndex) => {
      if (outcome.accepted) {
        result.acceptedCount += 1;
        if (outcome.messageName) result.messageNames.push(outcome.messageName);
        return;
      }

      result.rejectedCount += 1;
      if (outcome.invalidToken && batch[outcomeIndex]) {
        result.invalidTokenIds.push(batch[outcomeIndex].id);
      }
    });
  }

  return result;
}

async function sendFcmMessage(
  accessToken: string,
  token: string,
  notification: FcmNotification,
): Promise<{ accepted: boolean; messageName?: string; invalidToken?: boolean }> {
  const serviceAccount = getServiceAccount();
  const endpoint = "https://fcm.googleapis.com/v1/projects/"
    + encodeURIComponent(serviceAccount.project_id)
    + "/messages:send";
  const message = {
    message: {
      token,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      ...(notification.data ? { data: notification.data } : {}),
      android: {
        priority: "HIGH",
        notification: {
          channel_id: "challenge-events",
          sound: "default",
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: "Bearer " + accessToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
  });
  const payload = await response.json().catch(() => null) as FcmApiResponse | null;

  if (response.ok) {
    return {
      accepted: true,
      ...(typeof payload?.name === "string" ? { messageName: payload.name } : {}),
    };
  }

  if (isInvalidRegistrationToken(response.status, payload)) {
    return { accepted: false, invalidToken: true };
  }
  throw new Error("fcm_http_" + response.status);
}

function isInvalidRegistrationToken(
  statusCode: number,
  payload: FcmApiResponse | null,
): boolean {
  const status = typeof payload?.error?.status === "string"
    ? payload.error.status
    : "";
  if (status === "UNREGISTERED") return true;
  if (statusCode !== 400 || status !== "INVALID_ARGUMENT") return false;

  const message = typeof payload?.error?.message === "string"
    ? payload.error.message
    : "";
  const details = JSON.stringify(payload?.error?.details ?? "");
  return /registration token/i.test(message)
    || /message\.token/i.test(details);
}

function getServiceAccount(): ServiceAccount {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("FCM_SERVICE_ACCOUNT_JSON is not configured");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON is invalid");
  }

  const value = parsed as Record<string, unknown>;
  const projectId = value.project_id;
  const clientEmail = value.client_email;
  const privateKey = value.private_key;
  const tokenUri = value.token_uri;
  if (typeof projectId !== "string"
    || typeof clientEmail !== "string"
    || typeof privateKey !== "string") {
    throw new Error("FCM service account fields are incomplete");
  }

  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
    token_uri: typeof tokenUri === "string" && tokenUri ? tokenUri : defaultTokenUri,
  };
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + accessTokenSkewMs) {
    return cachedAccessToken.value;
  }

  const serviceAccount = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlEncodeJson({
    iss: serviceAccount.client_email,
    scope: fcmScope,
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
  });
  const unsignedToken = header + "." + claims;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(unsignedToken),
  );
  const assertion = unsignedToken + "." + base64UrlEncode(new Uint8Array(signature));

  const response = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error("fcm_oauth_http_" + response.status);

  const payload = await response.json().catch(() => null) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (typeof payload?.access_token !== "string") {
    throw new Error("fcm_oauth_response_invalid");
  }

  const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0
    ? payload.expires_in
    : 3600;
  cachedAccessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return payload.access_token;
}

function base64UrlEncodeJson(value: object): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
