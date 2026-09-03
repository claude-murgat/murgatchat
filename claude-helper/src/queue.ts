// File des tours : une conversation à la fois par utilisateur, deux tours au
// plus en parallèle sur la VM (3,7 Gio de RAM — chaque tour est un process
// Claude Code complet). Les messages arrivés pendant qu'un tour de la même
// conversation tourne sont bufferisés puis fusionnés dans le tour suivant,
// comme des messages empilés dans un chat.

import { runTurn } from "./agent.ts";
import { sendCallback, sendProgress } from "./callback.ts";

const MAX_BUFFER = 20;
const MAX_CONCURRENT = 2;

type Pending = { message: string; author: string | null };
type Conv = { running: boolean; buffer: Pending[] };

const convs = new Map<string, Conv>();
let runningCount = 0;
const waiting: string[] = []; // conversations prêtes, en attente d'un slot

export function queueDepth(): number {
  let n = 0;
  for (const c of convs.values()) n += c.buffer.length + (c.running ? 1 : 0);
  return n;
}

export function enqueueTurn(key: string, message: string, author: string | null): boolean {
  let conv = convs.get(key);
  if (!conv) {
    conv = { running: false, buffer: [] };
    convs.set(key, conv);
  }
  if (conv.buffer.length >= MAX_BUFFER) return false;
  conv.buffer.push({ message, author });
  if (!conv.running && !waiting.includes(key)) waiting.push(key);
  pump();
  return true;
}

function pump() {
  while (runningCount < MAX_CONCURRENT && waiting.length > 0) {
    const key = waiting.shift()!;
    const conv = convs.get(key);
    if (!conv || conv.running || conv.buffer.length === 0) continue;
    conv.running = true;
    runningCount++;
    void drain(key, conv);
  }
}

async function drain(key: string, conv: Conv) {
  try {
    while (conv.buffer.length > 0) {
      const batch = conv.buffer.splice(0, conv.buffer.length);
      const prompt = batch
        .map((p) => (p.author ? `[${p.author}] ${p.message}` : p.message))
        .join("\n\n");
      let outcome: { ok: boolean; reply?: string; error?: string };
      try {
        outcome = await runTurn(key, prompt, (text) => void sendProgress(key, text));
      } catch (e) {
        console.error(`[helper] tour ${key} en échec:`, (e as Error).message);
        outcome = { ok: false, error: "turn_failed" };
      }
      await sendCallback({ channelId: key, ...outcome });
    }
  } finally {
    conv.running = false;
    runningCount--;
    if (conv.buffer.length > 0 && !waiting.includes(key)) waiting.push(key);
    pump();
  }
}
