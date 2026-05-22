import { prisma } from "./db.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

function isExpoToken(t) {
  return (
    typeof t === "string" &&
    (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
  );
}

// Send Expo push notifications. messages: [{ to, title, body, data }].
// Tokens Expo reports as DeviceNotRegistered are pruned from the DB.
export async function sendExpoPush(messages) {
  const valid = (messages || []).filter((m) => isExpoToken(m.to));
  if (valid.length === 0) return;

  let result;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    });
    result = await res.json().catch(() => null);
  } catch (e) {
    console.error("[push] Expo send failed:", e.message);
    return;
  }

  const tickets = result?.data;
  if (Array.isArray(tickets)) {
    const toPrune = [];
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
