// Règles de gestion des conversations côté client — le miroir de celles du
// serveur (server/src/routes/channels.ts), qui reste seul juge : ces fonctions
// ne servent qu'à n'afficher que les actions permises.
//
// Depuis la 1.6.0, un « groupe de discussion » est un salon privé :
//   - tout membre d'un salon ajoute, retire, renomme, décrit et quitte ;
//   - seul un admin supprime un salon ou change sa visibilité ;
//   - le salon par défaut (« Général ») ne se modifie que par un admin, et ne
//     se quitte ni ne se supprime ;
//   - une conversation directe ne se quitte pas : elle se masque.
// Le lecteur ne voit dans sa liste que des conversations dont il est membre.
import type { Channel, User } from "./types.ts";

/** Salon (public ou privé) : ni conversation directe, ni conversation d'expert Claude. */
export function isSalon(c: Channel) {
  return !c.isDirect && c.kind !== "claude";
}

/** « Mes notes » : la conversation directe dont le lecteur est le seul membre. */
export function isSelfDm(c: Channel, user: User) {
  return c.isDirect && c.members.length === 1 && c.members[0]?.id === user.id;
}

/** Conversation directe masquée par le lecteur, sans message arrivé depuis. */
export function isHiddenDm(c: Channel) {
  if (!c.isDirect || !c.hiddenAt) return false;
  if (!c.lastMessage?.createdAt) return true;
  return new Date(c.lastMessage.createdAt).getTime() <= new Date(c.hiddenAt).getTime();
}

/** Renommer / décrire le salon. */
export function canEditSalon(c: Channel, user: User) {
  return isSalon(c) && (!c.isDefault || user.isAdmin);
}

/** Passer le salon de public à privé ou l'inverse. */
export function canChangeVisibility(c: Channel, user: User) {
  return isSalon(c) && !c.isDefault && user.isAdmin;
}

/** Ajouter ou retirer des membres, quitter le salon. */
export function canManageMembers(c: Channel) {
  return isSalon(c) && !c.isDefault;
}

/** Supprimer le salon et tout son contenu. */
export function canDeleteSalon(c: Channel, user: User) {
  return isSalon(c) && !c.isDefault && user.isAdmin;
}

/** Masquer une conversation directe (pas « Mes notes », épinglée à part). */
export function canHideConversation(c: Channel, user: User) {
  return c.isDirect && !isSelfDm(c, user);
}

/** Même ensemble de personnes (ordre indifférent). */
export function sameMembers(c: Channel, userIds: string[]) {
  const ids = new Set(userIds);
  return c.members.length === ids.size && c.members.every((m) => ids.has(m.id));
}

// Nom proposé pour un salon privé créé à partir d'une liste de personnes : les
// membres par ordre alphabétique, dans la limite de 80 caractères d'un nom de
// salon (même règle que defaultSalonName côté serveur).
export function defaultSalonName(displayNames: string[]) {
  const names = [...displayNames]
    .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }))
    .join(", ");
  return names.length > 80 ? `${names.slice(0, 79)}…` : names;
}

/** Libellé d'un salon avec son préfixe : « # projet » ou « 🔒 projet ». */
export function salonLabel(c: Pick<Channel, "isPrivate" | "name">) {
  return `${c.isPrivate ? "🔒" : "#"} ${c.name || "salon"}`;
}
