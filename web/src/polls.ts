// Sondages côté client : bornes (miroir de server/src/polls.ts), libellés et
// calcul de la sélection, partagés par PollModal (création) et PollCard (vote).
import type { Poll, User } from "./types.ts";

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 20;

// Deux réponses qui ne diffèrent que par la casse ou les espaces sont la même
// (même règle que le serveur, qui refuse le doublon).
export function sameOption(a: string, b: string) {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
  return norm(a) === norm(b);
}

/** Réponses pour lesquelles `userId` a voté. */
export function myVotes(poll: Poll, userId: string | undefined) {
  if (!userId) return [];
  return poll.options.filter((o) => o.voters.some((v) => v.id === userId)).map((o) => o.id);
}

// Sélection après un clic sur `optionId`. Choix unique : la réponse remplace la
// précédente, et un second clic sur la même retire le vote. Choix multiple : le
// clic coche ou décoche la réponse.
export function nextSelection(poll: Poll, mine: string[], optionId: string) {
  const has = mine.includes(optionId);
  if (!poll.multiple) return has ? [] : [optionId];
  return has ? mine.filter((id) => id !== optionId) : [...mine, optionId];
}

/** Part d'une réponse en pourcentage des votants (0 sans votant). */
export function share(count: number, voterCount: number) {
  return voterCount ? Math.round((count / voterCount) * 100) : 0;
}

// « Alice », « Alice et Bob », « Alice, Bob et 3 autres ».
export function votersLabel(voters: Pick<User, "displayName">[] | { displayName?: string }[]) {
  const names = voters.map((v) => v.displayName || "Quelqu'un");
  if (names.length <= 2) return names.join(" et ");
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} et ${others} autre${others > 1 ? "s" : ""}`;
}

export function votersCountLabel(n: number) {
  return n === 0 ? "Aucun vote" : `${n} votant${n > 1 ? "s" : ""}`;
}

// Codes d'erreur du serveur (routes/polls.ts) → message lisible.
const ERRORS: Record<string, string> = {
  invalid_question: `La question est obligatoire (${POLL_QUESTION_MAX} caractères au plus).`,
  option_too_long: `Une réponse fait ${POLL_OPTION_MAX} caractères au plus.`,
  invalid_option_count: `Il faut entre ${POLL_OPTIONS_MIN} et ${POLL_OPTIONS_MAX} réponses.`,
  duplicate_option: "Cette réponse existe déjà.",
  polls_in_salons_only: "Les sondages se publient dans les groupes.",
  not_a_member: "Vous ne faites plus partie de ce groupe.",
  poll_closed: "Ce sondage est clôturé.",
  single_choice: "Une seule réponse possible.",
  unknown_option: "Cette réponse n'existe plus. Rechargez la conversation.",
  options_locked: "Seul l'auteur du sondage peut ajouter des réponses.",
  too_many_options: `Ce sondage a déjà ${POLL_OPTIONS_MAX} réponses.`,
  invalid_option: `Une réponse fait entre 1 et ${POLL_OPTION_MAX} caractères.`,
  not_allowed: "Seuls l'auteur du sondage et les admins du groupe peuvent le clôturer.",
  not_found: "Ce sondage n'existe plus.",
};

export function pollErrorText(err: unknown, fallback = "Action impossible. Réessayez.") {
  const message = (err as { message?: string } | null)?.message || "";
  return ERRORS[message] || fallback;
}
