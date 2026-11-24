// Sondages dans les salons : un membre pose une question, choisit le choix
// unique ou multiple et s'il laisse les autres membres proposer des réponses.
//
//   POST /polls                 { channelId, question, options[], multiple, allowAddOptions }
//   PUT  /polls/:id/votes       { optionIds[] }   — remplace les votes de l'appelant
//   POST /polls/:id/options     { text }          — ajoute une réponse
//   POST /polls/:id/close                         — clôture (auteur ou admin)
//
// Le sondage est porté par un message ordinaire : il arrive par `message:new`,
// notifie et compte comme non lu comme un autre. Les changements (votes,
// réponses, clôture) partent en `poll:update` vers la room du salon, dont seuls
// les membres font partie : un salon privé reste invisible aux autres, admins
// du chat compris (chaque route exige l'adhésion).
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Membership, Prisma } from "@prisma/client";
import { prisma } from "../db.ts";
import { requireAuth } from "../auth.ts";
import { encryptBody, decryptBody } from "../crypto.ts";
import { notifyMembers } from "../socket.ts";
import { isManagedSalon, serializeMessage } from "./channels.ts";
import {
  POLL_INCLUDE,
  POLL_OPTION_MAX,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_QUESTION_MAX,
  pollFallbackText,
  pollSearchText,
  sameOption,
  serializePoll,
} from "../polls.ts";

const router = Router();

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ");

const CreateSchema = z.object({
  channelId: z.string().min(1),
  question: z.string(),
  options: z.array(z.string()).max(POLL_OPTIONS_MAX * 2),
  multiple: z.boolean().optional().default(false),
  allowAddOptions: z.boolean().optional().default(false),
});

// Verrouille la ligne du sondage jusqu'à la fin de la transaction : votes,
// ajouts de réponses et clôture d'un même sondage passent l'un après l'autre
// (un double clic ne laisse pas deux votes en choix unique, deux ajouts
// simultanés ne créent ni doublon ni 21e réponse, et rien ne passe après la
// clôture).
async function lockPoll(tx: Prisma.TransactionClient, pollId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Poll" WHERE "id" = ${pollId} FOR NO KEY UPDATE`;
  return tx.poll.findUnique({ where: { id: pollId }, include: { options: true } });
}

// Chaque changement fait avancer la version, dans la même transaction que lui :
// les états diffusés (qui peuvent partir dans le désordre, la relecture se
// faisant après le verrou) sont ainsi ordonnés pour les clients.
function bumpVersion(tx: Prisma.TransactionClient, pollId: string, data: Prisma.PollUpdateInput = {}) {
  return tx.poll.update({ where: { id: pollId }, data: { ...data, version: { increment: 1 } } });
}

// Le sondage, son message et l'adhésion de l'appelant à son salon. `null` (404)
// pour un sondage inconnu ou dont le message n'est pas publié ; 403 pour un
// non-membre, qu'on ne renseigne pas davantage.
const WITH_MESSAGE = { message: { include: { channel: true } } } satisfies Prisma.PollInclude;
type PollWithMessage = Prisma.PollGetPayload<{ include: typeof WITH_MESSAGE }>;

async function loadForMember(
  req: Request,
  res: Response
): Promise<{ poll: PollWithMessage; membership: Membership } | null> {
  const poll = await prisma.poll.findUnique({
    where: { id: String(req.params.pollId) },
    include: WITH_MESSAGE,
  });
  if (!poll || !poll.message.delivered) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const membership = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: poll.message.channelId } },
  });
  if (!membership) {
    res.status(403).json({ error: "not_a_member" });
    return null;
  }
  return { poll, membership };
}

// Recharge le sondage, le diffuse au salon et le renvoie à l'appelant.
async function broadcast(req: Request, res: Response, pollId: string, messageId: string, channelId: string) {
  const fresh = await prisma.poll.findUnique({ where: { id: pollId }, include: POLL_INCLUDE });
  if (!fresh) return res.status(404).json({ error: "not_found" });
  const poll = serializePoll(fresh);
  req.io?.to(`channel:${channelId}`).emit("poll:update", { messageId, channelId, poll });
  return res.json({ messageId, channelId, poll });
}

router.post("/", requireAuth, async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_poll" });
  const { channelId, multiple, allowAddOptions } = parsed.data;

  const question = parsed.data.question.trim();
  if (!question || question.length > POLL_QUESTION_MAX) {
    return res.status(400).json({ error: "invalid_question" });
  }
  // Les champs laissés vides dans le formulaire sont ignorés.
  const options = parsed.data.options.map(oneLine).filter(Boolean);
  if (options.some((o) => o.length > POLL_OPTION_MAX)) {
    return res.status(400).json({ error: "option_too_long" });
  }
  if (options.length < POLL_OPTIONS_MIN || options.length > POLL_OPTIONS_MAX) {
    return res.status(400).json({ error: "invalid_option_count" });
  }
  if (options.some((o, i) => options.findIndex((x) => sameOption(x, o)) !== i)) {
    return res.status(400).json({ error: "duplicate_option" });
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId } },
    include: { channel: true },
  });
  if (!membership) return res.status(403).json({ error: "not_a_member" });
  // Les salons seulement (publics ou privés) : ni message direct, ni « Mes
  // notes », ni conversation avec un expert Claude.
  const { channel } = membership;
  if (channel.isDirect || channel.kind !== "standard") {
    return res.status(400).json({ error: "polls_in_salons_only" });
  }

  const msg = await prisma.message.create({
    data: {
      channelId,
      authorId: req.userId,
      body: encryptBody(pollFallbackText(question)),
      searchableBody: pollSearchText(question, options),
      poll: {
        create: {
          question: encryptBody(question),
          multiple,
          allowAddOptions,
          options: {
            create: options.map((text, position) => ({ text: encryptBody(text), position })),
          },
        },
      },
    },
    include: { author: true, attachments: true, poll: { include: POLL_INCLUDE } },
  });

  const serialized = serializeMessage(msg);
  req.io?.to(`channel:${channelId}`).emit("message:new", serialized);
  if (req.io) await notifyMembers(req.io, channelId, req.userId, serialized);
  res.status(201).json({ message: serialized });
});

// Remplace les votes de l'appelant par `optionIds` (vide : il retire son vote).
// Le client envoie la sélection voulue plutôt qu'une bascule : rejouée (double
// envoi, deux appareils), la requête donne le même résultat.
router.put("/:pollId/votes", requireAuth, async (req, res) => {
  const raw = req.body?.optionIds;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string") || raw.length > POLL_OPTIONS_MAX) {
    return res.status(400).json({ error: "invalid_votes" });
  }
  const optionIds = Array.from(new Set(raw as string[]));

  const ctx = await loadForMember(req, res);
  if (!ctx) return;
  const { poll } = ctx;
  if (!poll.multiple && optionIds.length > 1) {
    return res.status(400).json({ error: "single_choice" });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockPoll(tx, poll.id);
    if (!locked) return "not_found";
    if (locked.closedAt) return "poll_closed";
    const known = new Set(locked.options.map((o) => o.id));
    if (optionIds.some((id) => !known.has(id))) return "unknown_option";
    await tx.pollVote.deleteMany({
      where: { userId: req.userId, option: { pollId: poll.id } },
    });
    if (optionIds.length) {
      await tx.pollVote.createMany({
        data: optionIds.map((optionId) => ({ optionId, userId: req.userId })),
      });
    }
    await bumpVersion(tx, poll.id);
    return "ok";
  });
  if (outcome === "not_found") return res.status(404).json({ error: "not_found" });
  if (outcome === "poll_closed") return res.status(409).json({ error: "poll_closed" });
  if (outcome === "unknown_option") return res.status(400).json({ error: "unknown_option" });
  return broadcast(req, res, poll.id, poll.messageId, poll.message.channelId);
});

// Ajoute une réponse : tout membre si l'auteur l'a permis, sinon l'auteur seul.
router.post("/:pollId/options", requireAuth, async (req, res) => {
  const text = typeof req.body?.text === "string" ? oneLine(req.body.text) : "";
  if (!text || text.length > POLL_OPTION_MAX) {
    return res.status(400).json({ error: "invalid_option" });
  }

  const ctx = await loadForMember(req, res);
  if (!ctx) return;
  const { poll } = ctx;
  if (!poll.allowAddOptions && poll.message.authorId !== req.userId) {
    return res.status(403).json({ error: "options_locked" });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockPoll(tx, poll.id);
    if (!locked) return "not_found";
    if (locked.closedAt) return "poll_closed";
    if (locked.options.length >= POLL_OPTIONS_MAX) return "too_many_options";
    if (locked.options.some((o) => sameOption(decryptBody(o.text), text))) return "duplicate_option";
    const position = Math.max(-1, ...locked.options.map((o) => o.position)) + 1;
    await tx.pollOption.create({
      data: { pollId: poll.id, text: encryptBody(text), position, addedById: req.userId },
    });
    // La nouvelle réponse devient cherchable comme les autres.
    const texts = [...locked.options.map((o) => decryptBody(o.text)), text];
    await tx.message.update({
      where: { id: poll.messageId },
      data: { searchableBody: pollSearchText(decryptBody(locked.question), texts) },
    });
    await bumpVersion(tx, poll.id);
    return "ok";
  });
  if (outcome === "not_found") return res.status(404).json({ error: "not_found" });
  if (outcome === "poll_closed") return res.status(409).json({ error: "poll_closed" });
  if (outcome === "too_many_options") return res.status(409).json({ error: "too_many_options" });
  if (outcome === "duplicate_option") return res.status(409).json({ error: "duplicate_option" });
  return broadcast(req, res, poll.id, poll.messageId, poll.message.channelId);
});

// Clôture : l'auteur du sondage, un admin du salon ou un admin du chat (membre
// du salon, comme pour toute route ici). Idempotente.
router.post("/:pollId/close", requireAuth, async (req, res) => {
  const ctx = await loadForMember(req, res);
  if (!ctx) return;
  const { poll, membership } = ctx;
  const allowed =
    poll.message.authorId === req.userId ||
    !!req.user?.isAdmin ||
    (isManagedSalon(poll.message.channel) && membership.role === "admin");
  if (!allowed) return res.status(403).json({ error: "not_allowed" });

  await prisma.$transaction(async (tx) => {
    const locked = await lockPoll(tx, poll.id);
    if (locked && !locked.closedAt) {
      await bumpVersion(tx, poll.id, { closedAt: new Date() });
    }
  });
  return broadcast(req, res, poll.id, poll.messageId, poll.message.channelId);
});

export default router;
