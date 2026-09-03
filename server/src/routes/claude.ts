// Section CLAUDE — la conversation de chaque utilisateur avec l'expert
// « supervision ». Le canal est un vrai Channel (kind: "claude", privé, membres
// = l'utilisateur + le bot claude) : on hérite ainsi de message:new, des badges
// non-lus, des notifications/push (crucial : une analyse dure des minutes), de
// la recherche et de toute l'UI ChannelView. Le cerveau tourne sur la VM
// claude-helper (voir ../claudeHelper.ts) ; ce fichier expose l'ouverture de la
// conversation et le webhook de retour.

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.ts";
import { requireAuth } from "../auth.ts";
import { ensureBot } from "../notify.ts";
import {
  claudeExpertEnabled,
  callbackTokenMatches,
  stopTyping,
  deliverBotReply,
} from "../claudeHelper.ts";
import { serializeChannel } from "./channels.ts";

const router = Router();

export const CLAUDE_CHANNEL_NAME = "Expert supervision";

// Ouvre (ou retrouve) LA conversation de l'appelant avec l'expert. Idempotent :
// un seul canal kind="claude" par utilisateur, même sous double-clic — d'où le
// findFirst avant création plutôt qu'une contrainte dédiée en base.
router.post("/conversation", requireAuth, async (req, res) => {
  if (!claudeExpertEnabled()) {
    return res.status(503).json({ error: "claude_expert_unavailable" });
  }
  const include = {
    memberships: { include: { user: true } },
    messages: { orderBy: { createdAt: "desc" as const }, take: 1 },
  };

  const existing = await prisma.channel.findFirst({
    where: { kind: "claude", memberships: { some: { userId: req.userId } } },
    include,
  });
  if (existing) {
    return res.json({ channel: serializeChannel(existing, req.userId) });
  }

  const bot = await ensureBot();
  const channel = await prisma.channel.create({
    data: {
      kind: "claude",
      isDirect: false,
      isPrivate: true,
      name: CLAUDE_CHANNEL_NAME,
      description:
        "Conversation privée avec l'expert Claude de l'application SUPERVISION.",
      memberships: { create: [{ userId: req.userId }, { userId: bot.id }] },
    },
    include,
  });

  // Même chorégraphie que POST /channels/dm : prévenir les onglets/appareils de
  // l'utilisateur et les abonner à la room du canal. Le bot n'a pas de socket.
  const personalized = serializeChannel(channel, req.userId);
  req.io?.to(`user:${req.userId}`).emit("channel:created", personalized);
  req.io?.in(`user:${req.userId}`).socketsJoin(`channel:${channel.id}`);
  res.json({ channel: personalized });
});

// Retour du helper (machine à machine) : la réponse de l'expert, ou son échec.
// Auth par secret partagé (CLAUDE_CALLBACK_TOKEN), PAS un JWT utilisateur —
// donc pas de requireAuth. Clone du modèle POST /support/notify.
const callbackSchema = z.object({
  channelId: z.string().min(1).max(60),
  ok: z.boolean(),
  reply: z.string().max(20_000).optional(),
  error: z.string().max(300).optional(),
});

router.post("/callback", async (req, res) => {
  if (!claudeExpertEnabled()) {
    return res.status(503).json({ error: "claude_expert_unavailable" });
  }
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!callbackTokenMatches(provided)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsed = callbackSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_payload" });
  const { channelId, ok, reply, error } = parsed.data;

  // N'accepter que les canaux de l'expert : un channelId d'un salon normal
  // (deviné ou rejoué) ne doit pas permettre d'y faire parler le bot.
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel || channel.kind !== "claude") {
    return res.status(404).json({ error: "not_found" });
  }

  stopTyping(channelId);
  const text =
    ok && reply
      ? reply
      : `⚠️ L'analyse a échoué (${error || "erreur inconnue"}). Reformulez ou réessayez ; si ça persiste, regardez le journal du service claude-helper.`;

  try {
    if (req.io) await deliverBotReply(req.io, channelId, text);
    res.json({ ok: true });
  } catch (e) {
    console.error("[claude-helper] callback delivery failed:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "callback_failed" });
  }
});

export default router;
