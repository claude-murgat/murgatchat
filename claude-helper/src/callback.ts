// Livraison de la réponse à MurgaChat. Le chat peut être en plein redéploiement
// au moment où l'analyse se termine : on retente (30 s, 2 min, 10 min) puis on
// range le paquet en dead-letter — l'utilisateur reçoit alors le message
// d'échec générique du garde-fou typing côté serveur, et un humain peut rejouer
// le fichier à la main (curl) si la réponse valait le coup.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEADLETTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "state", "deadletter");
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

type CallbackPayload = {
  channelId: string;
  ok: boolean;
  reply?: string;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendCallback(payload: CallbackPayload) {
  const url = process.env.CALLBACK_URL || "";
  const token = process.env.CALLBACK_TOKEN || "";
  if (!url || !token) {
    console.error("[helper] CALLBACK_URL/CALLBACK_TOKEN manquants — réponse perdue");
    return deadletter(payload);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      // 4xx = rejeté définitivement (canal supprimé, payload invalide…) : les
      // retries n'y changeront rien.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.error(`[helper] callback rejeté (${res.status}) — dead-letter`);
        return deadletter(payload);
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.error(`[helper] callback abandonné (${(e as Error).message}) — dead-letter`);
        return deadletter(payload);
      }
      console.warn(
        `[helper] callback en échec (${(e as Error).message}), retry dans ${
          RETRY_DELAYS_MS[attempt] / 1000
        }s`
      );
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function deadletter(payload: CallbackPayload) {
  try {
    mkdirSync(DEADLETTER_DIR, { recursive: true });
    const file = join(DEADLETTER_DIR, `${Date.now()}-${payload.channelId}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2));
    console.error(`[helper] réponse rangée dans ${file}`);
  } catch (e) {
    console.error("[helper] dead-letter impossible:", (e as Error).message);
  }
}
