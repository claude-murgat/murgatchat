// Service claude-helper — le « cerveau » des experts Claude de MurgaChat, sur sa VM.
//
// MurgaChat POSTe chaque message utilisateur sur /turn et reçoit un 202
// immédiat ; le tour (Agent SDK, outils ssh/db/lecture) tourne ensuite en tâche
// de fond dans le workspace de l'expert visé (voir experts.ts) et la réponse
// repart par POST {CALLBACK_URL} (voir callback.ts). Une analyse peut durer
// plusieurs minutes : aucun appel n'est synchrone.
//
// Env requis (.env, chargé par --env-file ou systemd EnvironmentFile) :
//   CLAUDE_CODE_OAUTH_TOKEN (ou ANTHROPIC_API_KEY)  accès modèle, lu par l'Agent SDK
//   HELPER_TOKEN       secret des appels entrants (= CLAUDE_HELPER_TOKEN côté chat)
//   CALLBACK_URL       ex. http://172.16.1.30:4000/claude/callback
//   CALLBACK_TOKEN     secret du callback (= CLAUDE_CALLBACK_TOKEN côté chat)
//   PORT               défaut 7070
//   WORKSPACE          workspace de l'expert supervision (défaut /home/murgat/claude-helper)
//   WORKSPACE_<CLÉ>    workspace des autres experts, ex. WORKSPACE_MANAGEMENT

import { timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { enqueueTurn, queueDepth } from "./queue.ts";
import { runSupportTurn } from "./support.ts";
import { DEFAULT_EXPERT, knownExperts, workspaceFor } from "./experts.ts";

const PORT = Number(process.env.PORT || 7070);

function tokenMatches(provided: string): boolean {
  const expected = process.env.HELPER_TOKEN || "";
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const turnSchema = z.object({
  conversationKey: z.string().min(1).max(60),
  // Clé de l'expert (registre côté chat) ; absente = supervision, pour les
  // serveurs de chat antérieurs à la section multi-experts.
  expert: z.string().min(1).max(40).optional(),
  message: z.string().min(1).max(20_000),
  author: z.object({ displayName: z.string().max(120).nullable() }).optional(),
});

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, pending: queueDepth(), experts: knownExperts() });
});

app.post("/turn", (req, res) => {
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(provided)) return res.status(401).json({ error: "unauthorized" });

  const parsed = turnSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_payload" });

  const { conversationKey, message, author } = parsed.data;
  const expert = parsed.data.expert || DEFAULT_EXPERT;
  const workspace = workspaceFor(expert);
  if (!workspace) {
    console.warn(`[helper] tour ${conversationKey}: expert inconnu « ${expert} » (pas de WORKSPACE_*)`);
    return res.status(400).json({ error: "unknown_expert" });
  }
  const accepted = enqueueTurn(conversationKey, message, author?.displayName ?? null, workspace);
  if (!accepted) return res.status(429).json({ error: "queue_full" });
  res.status(202).json({ ok: true });
});

// Relais du chat de support in-app (voir support.ts). Synchrone : le serveur de
// chat attend la réponse (quelques secondes, le modal affiche « réfléchit… »).
// Au plus 2 tours en parallèle — chacun est un process Claude Code complet.
const supportSchema = z.object({
  system: z.string().min(1).max(40_000),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .min(1)
    .max(60),
});
const SUPPORT_MAX_CONCURRENT = 2;
let supportRunning = 0;

app.post("/support-turn", async (req, res) => {
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(provided)) return res.status(401).json({ error: "unauthorized" });

  const parsed = supportSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_payload" });
  if (supportRunning >= SUPPORT_MAX_CONCURRENT) return res.status(429).json({ error: "busy" });

  supportRunning++;
  const started = Date.now();
  try {
    const out = await runSupportTurn(parsed.data.system, parsed.data.messages);
    console.log(
      `[helper] support-turn: ok en ${Math.round((Date.now() - started) / 1000)}s` +
        (out.finalize ? " (ticket finalisé)" : "")
    );
    res.json(out);
  } catch (e) {
    console.error("[helper] support-turn en échec:", (e as Error).message);
    res.status(502).json({ error: "turn_failed" });
  } finally {
    supportRunning--;
  }
});

for (const name of ["HELPER_TOKEN", "CALLBACK_URL", "CALLBACK_TOKEN"]) {
  if (!process.env[name]) console.warn(`[helper] ⚠️ ${name} manquant — voir .env`);
}

app.listen(PORT, () => {
  const experts = knownExperts()
    .map((k) => `${k} → ${workspaceFor(k)}`)
    .join(", ");
  console.log(`[helper] à l'écoute sur :${PORT} (experts : ${experts})`);
});
