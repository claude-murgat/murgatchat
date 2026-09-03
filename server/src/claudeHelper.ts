// Pont vers l'expert Claude « supervision » — le cerveau tourne sur une VM
// auxiliaire (service claude-helper/, voir ce dossier à la racine du dépôt).
// Ce module ne fait que déclencher un tour (webhook sortant) et animer
// l'indicateur de saisie ; la réponse revient plus tard par POST
// /claude/callback (routes/claude.ts), car une analyse peut durer plusieurs
// minutes — le modèle requête/réponse du chat support ne convient pas ici.
//
// Même philosophie que anthropic.ts / github.ts : env lu paresseusement (les
// tests basculent la feature au cas par cas), absence de config = feature off
// silencieuse, erreurs loguées et avalées — un échec du pont ne doit jamais
// casser l'envoi du message de l'utilisateur.

import { timingSafeEqual } from "node:crypto";
import type { Server } from "socket.io";
import { ensureBot, postBotMessage } from "./notify.ts";
import { notifyMembers } from "./socket.ts";

function helperUrl() {
  return process.env.CLAUDE_HELPER_URL || "";
}
function helperToken() {
  return process.env.CLAUDE_HELPER_TOKEN || "";
}
function callbackToken() {
  return process.env.CLAUDE_CALLBACK_TOKEN || "";
}

export function claudeExpertEnabled() {
  return Boolean(helperUrl() && helperToken() && callbackToken());
}

// Comparaison en temps constant du secret du callback (même modèle que
// notify.ts:tokenMatches, dupliqué à dessein : les deux secrets sont distincts).
export function callbackTokenMatches(provided: string): boolean {
  const expected = callbackToken();
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- Indicateur « Claude est en train d'écrire… » -------------------------
// Le client efface l'indicateur 4 s après le dernier typing:update ; on ré-émet
// donc toutes les 3 s tant que le tour est en cours. Garde-fou dur à 20 min au
// cas où le callback ne viendrait jamais (helper mort, dead-letter).
const TYPING_INTERVAL_MS = 3_000;
const TYPING_MAX_MS = 20 * 60_000;
const typingLoops = new Map<string, NodeJS.Timeout>();

function startTyping(io: Server, channelId: string, botId: string) {
  stopTyping(channelId);
  const startedAt = Date.now();
  const emit = () =>
    io.to(`channel:${channelId}`).emit("typing:update", { channelId, userId: botId });
  emit(); // tout de suite — pas 3 s de silence avant le premier indicateur
  const loop = setInterval(() => {
    if (Date.now() - startedAt > TYPING_MAX_MS) return stopTyping(channelId);
    emit();
  }, TYPING_INTERVAL_MS);
  // Ne pas retenir le process ouvert juste pour un indicateur de saisie.
  loop.unref?.();
  typingLoops.set(channelId, loop);
}

export function stopTyping(channelId: string) {
  const loop = typingLoops.get(channelId);
  if (loop) clearInterval(loop);
  typingLoops.delete(channelId);
}

// Poste un message du bot dans le canal et le diffuse comme n'importe quel
// message (message:new + notifications/push). Utilisé pour la réponse de
// l'expert comme pour les messages d'erreur.
export async function deliverBotReply(io: Server, channelId: string, text: string) {
  const { authorId, serialized } = await postBotMessage(channelId, text);
  io.to(`channel:${channelId}`).emit("message:new", serialized);
  await notifyMembers(io, channelId, authorId, serialized);
}

// Déclenche un tour d'analyse pour `text` dans la conversation `channelId`.
// Fire-and-forget côté appelant (message:send) : toute erreur se traduit par
// un message du bot dans le canal, jamais par une exception remontée.
export async function dispatchExpertTurn(
  io: Server,
  channelId: string,
  text: string,
  author: { displayName: string | null }
) {
  if (!claudeExpertEnabled()) return;
  try {
    const res = await fetch(`${helperUrl()}/turn`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${helperToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversationKey: channelId,
        message: text,
        author: { displayName: author.displayName ?? null },
      }),
    });
    if (res.status !== 202) throw new Error(`helper responded ${res.status}`);
    const bot = await ensureBot();
    startTyping(io, channelId, bot.id);
  } catch (e) {
    console.error("[claude-helper] dispatch failed:", (e as Error).message);
    await deliverBotReply(
      io,
      channelId,
      "⚠️ L'expert supervision est injoignable pour le moment. Réessayez dans quelques minutes, ou vérifiez le service claude-helper sur sa VM."
    ).catch((err) => console.error("[claude-helper] fallback message failed:", err.message));
  }
}
