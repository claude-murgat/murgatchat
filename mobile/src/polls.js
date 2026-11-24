// Sondages des salons : bornes, sélection du votant, validation du formulaire de
// création et messages d'erreur. Le miroir des règles du serveur
// (server/src/polls.ts, server/src/routes/polls.ts). Fonctions pures, sans React.

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 20;

/** Un salon (public ou privé) : le seul endroit où le serveur accepte un sondage. */
export function canPollIn(channel) {
  return !!channel && !channel.isDirect && (channel.kind ?? "standard") === "standard";
}

const oneLine = (s) => (s || "").trim().replace(/\s+/g, " ");

/** Deux réponses qui ne diffèrent que par la casse ou les espaces sont la même. */
export function sameOption(a, b) {
  return oneLine(a).toLocaleLowerCase("fr") === oneLine(b).toLocaleLowerCase("fr");
}

/** Ids des réponses pour lesquelles `userId` a voté. */
export function myOptionIds(poll, userId) {
  return (poll?.options || [])
    .filter((o) => o.voters?.some((v) => v.id === userId))
    .map((o) => o.id);
}

// Sélection complète envoyée au serveur (PUT /polls/:id/votes remplace les votes) :
// en choix unique, toucher sa réponse la retire et toucher une autre la remplace ;
// en choix multiple, la réponse touchée s'ajoute ou se retire du lot.
export function nextSelection(poll, userId, optionId) {
  const mine = myOptionIds(poll, userId);
  const had = mine.includes(optionId);
  if (!poll.multiple) return had ? [] : [optionId];
  return had ? mine.filter((id) => id !== optionId) : [...mine, optionId];
}

/** Part des votants (0–100, arrondie) qui ont choisi la réponse. */
export function optionPercent(poll, option) {
  if (!poll?.voterCount) return 0;
  return Math.round((option.count / poll.voterCount) * 100);
}

// Noms des votants d'une réponse : tous, ou les trois premiers puis « et N autres ».
export function votersLabel(voters, all = false) {
  const names = (voters || []).map((v) => v.displayName || "Quelqu'un");
  if (all || names.length <= 3) return names.join(", ");
  const others = names.length - 3;
  return `${names.slice(0, 3).join(", ")} et ${others} autre${others > 1 ? "s" : ""}`;
}

export function voterCountLabel(n) {
  return `${n} votant${n > 1 ? "s" : ""}`;
}

/** Ajouter une réponse : permis à tous par l'auteur, ou à l'auteur seul ; jamais clos ni plein. */
export function canAddOption(poll, isAuthor) {
  return (
    !poll.closedAt &&
    (poll.allowAddOptions || isAuthor) &&
    (poll.options?.length || 0) < POLL_OPTIONS_MAX
  );
}

// Valide le formulaire de création comme le serveur : renvoie un message
// d'erreur, ou null et la charge utile de POST /polls (réponses vides écartées).
export function validatePollDraft({ question, options }) {
  const q = (question || "").trim();
  if (!q) return { error: "La question est obligatoire." };
  if (q.length > POLL_QUESTION_MAX) {
    return { error: `La question dépasse ${POLL_QUESTION_MAX} caractères.` };
  }
  const answers = (options || []).map(oneLine).filter(Boolean);
  if (answers.some((a) => a.length > POLL_OPTION_MAX)) {
    return { error: `Une réponse dépasse ${POLL_OPTION_MAX} caractères.` };
  }
  if (answers.length < POLL_OPTIONS_MIN) return { error: "Il faut au moins deux réponses." };
  if (answers.length > POLL_OPTIONS_MAX) {
    return { error: `Pas plus de ${POLL_OPTIONS_MAX} réponses.` };
  }
  if (answers.some((a, i) => answers.findIndex((x) => sameOption(x, a)) !== i)) {
    return { error: "Deux réponses sont identiques." };
  }
  return { error: null, question: q, options: answers };
}

const ERRORS = {
  invalid_poll: "Sondage invalide.",
  invalid_question: `La question est vide ou dépasse ${POLL_QUESTION_MAX} caractères.`,
  option_too_long: `Une réponse dépasse ${POLL_OPTION_MAX} caractères.`,
  invalid_option: `Réponse vide ou trop longue (${POLL_OPTION_MAX} caractères au plus).`,
  invalid_option_count: `Il faut entre ${POLL_OPTIONS_MIN} et ${POLL_OPTIONS_MAX} réponses.`,
  duplicate_option: "Cette réponse existe déjà.",
  too_many_options: `Ce sondage a déjà ${POLL_OPTIONS_MAX} réponses.`,
  options_locked: "L'auteur du sondage n'autorise pas l'ajout de réponses.",
  polls_in_salons_only: "Les sondages ne sont possibles que dans les salons.",
  not_a_member: "Vous n'êtes pas membre de ce salon.",
  single_choice: "Une seule réponse possible pour ce sondage.",
  invalid_votes: "Vote invalide.",
  unknown_option: "Cette réponse n'existe plus.",
  poll_closed: "Ce sondage est clôturé.",
  not_allowed: "Seuls l'auteur du sondage et les admins peuvent le clôturer.",
  not_found: "Sondage introuvable.",
};

/** Message en français pour une erreur levée par api.js (code serveur ou réseau). */
export function pollErrorMessage(e, fallback = "Action impossible.") {
  const code = e?.data?.error;
  if (typeof code === "string" && ERRORS[code]) return ERRORS[code];
  if (e?.network) return e.message;
  return fallback;
}
