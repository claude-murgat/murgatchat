// Règles de gestion des conversations côté client — le miroir de celles du
// serveur (server/src/routes/channels.ts), qui reste seul juge : ces fonctions
// ne servent qu'à n'afficher que les actions permises.
//
// Depuis la 1.6.0, un « groupe de discussion » est un salon privé :
//   - tout membre d'un salon ajoute des personnes, retire un membre, renomme,
//     décrit et quitte ;
//   - chaque salon a ses admins (« admins du salon », comme les gestionnaires
//     de Slack) : son créateur, puis ceux qu'un admin nomme. Avec les admins
//     du chat, ce sont eux qui suppriment le salon, changent sa visibilité,
//     nomment ou retirent des admins, et retirent un admin du salon ;
//   - un salon qui a des membres garde au moins un admin : quand le dernier
//     part, le serveur nomme le membre le plus ancien ;
//   - un compte désactivé n'est plus admin de rien (1.6.2) : le serveur le
//     retire d'`adminIds` et nomme un autre membre à sa place s'il le faut ;
//     on ne le nomme pas admin (403 target_disabled) ;
//   - le salon par défaut (« Général ») n'a pas d'admins de salon : il ne se
//     modifie que par un admin du chat, et ne se quitte ni ne se supprime ;
//   - une conversation directe ne se quitte pas : elle se masque.
// Le lecteur ne voit dans sa liste que des conversations dont il est membre.
// Un serveur 1.6.0 n'envoie pas `adminIds` : personne n'y est admin d'un salon,
// et ces règles retombent sur celles de la 1.6.0 (admins du chat seulement).
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

// Le compte technique « Claude » (auteur des messages des experts et du
// pipeline), reconnu comme le fait le serveur (BOT_USERNAME, server/src/notify.ts).
const BOT_USERNAME = "claude";

/**
 * Le bot technique. Un ancien groupe de discussion, devenu salon privé en
 * 1.6.0, peut le compter parmi ses membres : le serveur ne le compte jamais
 * comme une personne, ni ne le nomme admin du salon (403 bot_protected).
 */
export function isBot(u: Pick<User, "username">) {
  return u.username === BOT_USERNAME;
}

/**
 * Les personnes d'un salon, sans le bot : un salon privé où il ne reste plus que
 * lui est supprimé au départ du dernier membre, et il ne prend jamais le relais
 * d'un admin qui part.
 */
export function salonPeople(c: Channel) {
  return c.members.filter((m) => !isBot(m));
}

/** Admin du salon : son créateur, puis ceux qu'un admin a nommés. */
export function isSalonAdmin(c: Channel, user: Pick<User, "id">) {
  return !!c.adminIds?.includes(user.id);
}

/** Seul admin du salon : s'il part, le serveur nomme le membre le plus ancien. */
export function isOnlySalonAdmin(c: Channel, user: Pick<User, "id">) {
  // Les admins parmi les membres ACTUELS : un retrait appliqué localement peut
  // précéder l'évènement channel:members qui met `adminIds` à jour.
  const admins = c.members.filter((m) => isSalonAdmin(c, m));
  return admins.length === 1 && admins[0].id === user.id;
}

/**
 * Quelqu'un pour reprendre le salon si `user` le quitte : un autre membre au
 * compte actif. Le serveur ne nomme jamais un compte désactivé (1.6.2) : sans
 * lui, le seul admin qui part laisse le salon sans admin.
 */
export function hasSalonHeir(c: Channel, user: Pick<User, "id">) {
  return salonPeople(c).some((m) => m.id !== user.id && m.status !== "disabled");
}

/**
 * Administrer le salon (visibilité, suppression, admins) : admin du salon, ou
 * admin du chat — qui garde tous ses droits, y compris sur un salon dont il
 * n'est pas admin. « Général » reste aux admins du chat (canEditSalon).
 */
export function canAdministerSalon(c: Channel, user: User) {
  return isSalon(c) && !c.isDefault && (isSalonAdmin(c, user) || user.isAdmin);
}

/** Renommer / décrire le salon. */
export function canEditSalon(c: Channel, user: User) {
  return isSalon(c) && (!c.isDefault || user.isAdmin);
}

/** Passer le salon de public à privé ou l'inverse. */
export function canChangeVisibility(c: Channel, user: User) {
  return canAdministerSalon(c, user);
}

/** Ajouter ou retirer des membres, quitter le salon. */
export function canManageMembers(c: Channel) {
  return isSalon(c) && !c.isDefault;
}

/** Retirer `target` du salon (pas soi-même : c'est le quitter). */
export function canRemoveMember(c: Channel, user: User, target: Pick<User, "id">) {
  return (
    canManageMembers(c) &&
    target.id !== user.id &&
    // Un admin du salon ne se fait pas retirer par un simple membre.
    (!isSalonAdmin(c, target) || canAdministerSalon(c, user))
  );
}

/**
 * Nommer un admin du salon ou lui retirer ce rôle. Seulement là où le serveur
 * rapporte des admins : `adminIds` est absent d'un serveur 1.6.0 (qui n'a pas
 * la route) et vide hors des salons gérés — dont le salon du pipeline de
 * support, que le client ne sait pas reconnaître et où le serveur répondrait
 * no_roles. Un salon géré qui a des membres a toujours un admin.
 */
export function canManageRoles(c: Channel, user: User) {
  return canAdministerSalon(c, user) && !!c.adminIds?.length;
}

/** Supprimer le salon et tout son contenu. */
export function canDeleteSalon(c: Channel, user: User) {
  return canAdministerSalon(c, user);
}

/** Masquer une conversation directe (pas « Mes notes », épinglée à part). */
export function canHideConversation(c: Channel, user: User) {
  return c.isDirect && !isSelfDm(c, user);
}

/**
 * Le serveur a des admins de salon : il envoie `adminIds` sur chaque
 * conversation (un serveur 1.6.0 jamais), et le lecteur est au moins membre de
 * « Général ».
 */
export function serverHasSalonAdmins(channels: Channel[]) {
  return channels.some((c) => Array.isArray(c.adminIds));
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
