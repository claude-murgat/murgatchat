import { prisma } from "./db.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Message tel qu'attendu par l'API Expo (seul `to` est lu ici). */
export interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  sound?: string;
  data?: unknown;
}

/** Accusé de réception par message renvoyé par Expo. */
interface ExpoPushTicket {
  status?: string;
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushTicket[];
}

function isExpoToken(t: unknown): boolean {
  return (
    typeof t === "string" &&
    (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
  );
}

// Send Expo push notifications. messages: [{ to, title, body, data }].
// Tokens Expo reports as DeviceNotRegistered are pruned from the DB.
export async function sendExpoPush(
  messages: ExpoPushMessage[] | null | undefined
): Promise<ExpoPushResponse | null | undefined> {
  const valid = (messages || []).filter((m) => isExpoToken(m.to));
  if (valid.length === 0) return;

  let result: ExpoPushResponse | null | undefined;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    });
    // `Response.json()` est typé `unknown` : l'assertion décrit le contrat Expo.
    result = (await res.json().catch(() => null)) as ExpoPushResponse | null;
  } catch (e) {
    // Assertion plutôt que garde `instanceof Error` : une garde imposerait une
    // branche de repli, donc un comportement d'exécution différent.
    console.error("[push] Expo send failed:", (e as Error).message);
    return;
  }

  const tickets = result?.data;
  if (Array.isArray(tickets)) {
    const toPrune: string[] = [];
    tickets.forEach((t, i) => {
      if (t?.status === "error" && t?.details?.error === "DeviceNotRegistered") {
        toPrune.push(valid[i].to);
      }
    });
    if (toPrune.length) {
      await prisma.pushToken
        .deleteMany({ where: { token: { in: toPrune } } })
        .catch(() => {});
      console.log("[push] pruned invalid tokens:", toPrune.length);
    }
  }
  return result;
}
