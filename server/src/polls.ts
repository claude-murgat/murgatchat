// Sondages : bornes, include Prisma et sérialisation, partagés par les routes
// (routes/polls.ts) et le fil des messages (serializeMessage). Pas de route ici :
// channels.ts l'importe, et ce module ne doit rien importer de lui en retour.
import type { Poll, PollOption, PollVote, Prisma, User } from "@prisma/client";
import { decryptBody } from "./crypto.ts";

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 20;

// Ce qu'il faut charger pour sérialiser un sondage : ses réponses dans l'ordre,
// et chaque vote avec le nom de son auteur (affiché au survol, comme les
// réactions).
export const POLL_INCLUDE = {
  options: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { votes: { orderBy: { createdAt: "asc" }, include: { user: true } } },
  },
} satisfies Prisma.PollInclude;

export type PollWithRelations = Poll & {
  options?:
    | (PollOption & { votes?: (PollVote & { user?: Pick<User, "displayName"> | null })[] | null })[]
    | null;
};

// Texte du message qui porte le sondage : ce qu'affichent les notifications,
// l'aperçu de la barre latérale, les citations, les messages transférés et tout
// client qui ne connaît pas les sondages.
export function pollFallbackText(question: string) {
  return `📊 Sondage : ${question}`;
}

// Copie en clair pour la recherche plein texte (même compromis que
// Message.searchableBody) : la question et chaque réponse.
export function pollSearchText(question: string, options: string[]) {
  return [question, ...options].join("\n");
}

// Deux réponses qui ne diffèrent que par la casse ou les espaces sont la même.
export function sameOption(a: string, b: string) {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
  return norm(a) === norm(b);
}

export function serializePoll(p: PollWithRelations) {
  const options = (p.options || []).map((o) => {
    const voters = (o.votes || []).map((v) => ({
      id: v.userId,
      displayName: v.user?.displayName,
    }));
    return {
      id: o.id,
      text: decryptBody(o.text),
      addedById: o.addedById ?? null,
      count: voters.length,
      voters,
    };
  });
  // Votants distincts : en choix multiple, une personne peut compter sur
  // plusieurs réponses.
  const voterCount = new Set(options.flatMap((o) => o.voters.map((v) => v.id))).size;
  return {
    id: p.id,
    question: decryptBody(p.question),
    multiple: p.multiple,
    allowAddOptions: p.allowAddOptions,
    closedAt: p.closedAt ?? null,
    // Ordre des états : un client ignore un sondage de version inférieure.
    version: p.version,
    voterCount,
    options,
  };
}
