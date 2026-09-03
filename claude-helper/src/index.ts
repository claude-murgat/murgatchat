// Service claude-helper — le « cerveau » de l'expert supervision, sur sa VM.
//
// MurgaChat POSTe chaque message utilisateur sur /turn et reçoit un 202
// immédiat ; le tour (Agent SDK, outils ssh/db/lecture) tourne ensuite en tâche
// de fond et la réponse repart par POST {CALLBACK_URL} (voir callback.ts). Une
// analyse peut durer plusieurs minutes : aucun appel n'est synchrone.
//
// Env requis (.env, chargé par --env-file ou systemd EnvironmentFile) :
//   ANTHROPIC_API_KEY  clé du compte qui paie les tours (lu par l'Agent SDK)
//   HELPER_TOKEN       secret des appels entrants (= CLAUDE_HELPER_TOKEN côté chat)
//   CALLBACK_URL       ex. http://172.16.1.30:4000/claude/callback
//   CALLBACK_TOKEN     secret du callback (= CLAUDE_CALLBACK_TOKEN côté chat)
//   PORT               défaut 7070
//   WORKSPACE          défaut /home/murgat/claude-helper (cwd de l'agent)

import { timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { enqueueTurn, queueDepth } from "./queue.ts";

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
  message: z.string().min(1).max(20_000),
  author: z.object({ displayName: z.string().max(120).nullable() }).optional(),
});

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, pending: queueDepth() });
});

app.post("/turn", (req, res) => {
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(provided)) return res.status(401).json({ error: "unauthorized" });

  const parsed = turnSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_payload" });

  const { conversationKey, message, author } = parsed.data;
  const accepted = enqueueTurn(conversationKey, message, author?.displayName ?? null);
  if (!accepted) return res.status(429).json({ error: "queue_full" });
  res.status(202).json({ ok: true });
});

for (const name of ["ANTHROPIC_API_KEY", "HELPER_TOKEN", "CALLBACK_URL", "CALLBACK_TOKEN"]) {
  if (!process.env[name]) console.warn(`[helper] ⚠️ ${name} manquant — voir .env`);
}

app.listen(PORT, () => {
  console.log(`[helper] à l'écoute sur :${PORT} (workspace: ${process.env.WORKSPACE || "défaut"})`);
});
