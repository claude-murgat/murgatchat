import { Router } from "express";
import { z } from "zod";
import type { Server } from "socket.io";
import type {
  Attachment,
  Channel,
  Membership,
  Message,
  Prisma,
  Reaction,
  User,
} from "@prisma/client";
import { prisma } from "../db.ts";
import { requireAuth } from "../auth.ts";
import { publicUser } from "./auth.ts";
import { encryptBody, decryptBody } from "../crypto.ts";
import { safeUnlink } from "../storage.ts";
import { BOT_USERNAME, supportChannelName } from "../notify.ts";

// Formes « hydratées » renvoyées par nos requêtes Prisma. Les relations sont
// déclarées OPTIONNELLES parce que chaque appelant choisit son `include` : un
// message peut arriver avec ou sans réactions, un channel avec ou sans son
// dernier message. Les sérialiseurs ci-dessous gèrent déjà l'absence (`|| []`).
type ReactionWithUser = Reaction & { user?: User | null };

type MessageWithRelations = Message & {
  author?: User | null;
  attachments?: Attachment[] | null;
  reactions?: ReactionWithUser[] | null;
  parent?: (Message & { author?: User | null }) | null;
};

type ChannelWithRelations = Channel & {
  memberships?: (Membership & { user: User })[] | null;
  messages?: Message[] | null;
};

const router = Router();

// `adminIds` : même calcul que serializeChannel — un client 1.6.0 l'ignore et ne
// lit que `members`.
export async function broadcastMembers(
  io: Server | null | undefined,
  channelId: string
) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: { memberships: { include: { user: true } } },
  });
  io?.to(`channel:${channelId}`).emit("channel:members", {
    channelId,
    members: (channel?.memberships || []).map((m) => publicUser(m.user)),
    adminIds: channel ? salonAdminIds(channel) : [],
  });
}

// L'appartenance en base est la seule source de vérité de l'accès à un salon :
// chaque lecture ou écriture la revérifie (HTTP comme Socket.IO).
export async function isMember(userId: string, channelId: string) {
  const m = await prisma.membership.findUnique({
    where: { userId_channelId: { userId, channelId } },
    select: { id: true },
  });
  return m !== null;
}

// Dernier message d'une conversation tel que la barre latérale s'en sert (aperçu,
// tri des DM, non-lu) : un message de service n'y compte pas — « Bob a quitté le
// salon » ne doit rendre le salon non lu chez personne.
const LAST_MESSAGE_WHERE = { delivered: true, kind: "user" } satisfies Prisma.MessageWhereInput;
const CHANNEL_INCLUDE = {
  memberships: { include: { user: true } },
  messages: { orderBy: { createdAt: "desc" }, take: 1, where: LAST_MESSAGE_WHERE },
} satisfies Prisma.ChannelInclude;

/** Auteur d'une action sur un salon, tel qu'annoncé à la personne concernée. */
type Actor = { id: string; displayName: string };

// Pourquoi un salon disparaît de la liste d'un membre (évènement
// `channel:removed`) : son client peut le dire au lieu de le faire disparaître
// sans explication. Un client antérieur ne lit que `channelId`.
type RemovalInfo = {
  reason: "left" | "removed" | "deleted";
  by?: Actor;
  channelName?: string | null;
};

/** « Alice », « Alice et Bob », « Alice, Bob et Chloé ». */
export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
}

// Nom par défaut d'un salon privé créé à partir d'une liste de personnes (et
// des groupes convertis par la migration 20261029000000) : les membres par ordre
// alphabétique, dans la limite de 80 caractères d'un nom de salon.
export function defaultSalonName(displayNames: string[]) {
  const names = [...displayNames]
    .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }))
    .join(", ");
  return names.length > 80 ? `${names.slice(0, 79)}…` : names;
}

// Message de service posté au nom de `actorId` (« a ajouté Bob au salon ») :
// jamais notifié (ni push, ni évènement `notification`), exclu des non-lus, de
// l'aperçu et de la recherche (pas de `searchableBody`). Diffusé sous son propre
// évènement `message:system` : un client antérieur à la 1.6.0 l'ignore en direct
// (sur `message:new`, il en aurait fait un non-lu) et ne le voit qu'au
// rechargement du fil, comme un message de l'acteur — d'où un texte qui se lit
// tel quel après son nom.
export async function postSystemMessage(
  io: Server | null | undefined,
  channelId: string,
  actorId: string,
  text: string
) {
  // Au mieux : le salon a pu disparaître entre-temps (deux derniers membres qui
  // partent en même temps) — l'action elle-même a réussi, la trace n'a plus lieu
  // d'être.
  try {
    const msg = await prisma.message.create({
      data: {
        channelId,
        authorId: actorId,
        kind: "system",
        body: encryptBody(text),
        searchableBody: null,
      },
      include: { author: true, attachments: true },
    });
    const serialized = serializeMessage(msg);
    io?.to(`channel:${channelId}`).emit("message:system", serialized);
    return serialized;
  } catch (err) {
    console.warn("[channels] message de service non posté", channelId, (err as Error).message);
    return null;
  }
}

// Supprime un salon et tout son contenu (suppression par un admin, départ du
// dernier membre d'un salon privé, purge d'un compte) : la cascade emporte
// messages, membres et lignes de pièces jointes ; les fichiers chiffrés sur
// disque sont effacés ici, messages programmés compris.
export async function destroyChannel(io: Server | null | undefined, channelId: string) {
  const memberRows = await prisma.membership.findMany({
    where: { channelId },
    select: { userId: true },
  });
  const msgs = await prisma.message.findMany({
    where: { channelId },
    select: { attachments: { select: { storagePath: true } } },
  });
  const blobs = msgs.flatMap((m) => m.attachments.map((a) => a.storagePath));
  // deleteMany : idempotent si une suppression concurrente est passée avant.
  await prisma.channel.deleteMany({ where: { id: channelId } });
  await Promise.all(blobs.map((p) => safeUnlink(p)));
  for (const { userId } of memberRows) {
    io?.to(`user:${userId}`).emit("channel:removed", { channelId, reason: "deleted" });
    io?.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);
  }
}

// Le salon du pipeline de support (réservé aux admins, voir notify.ts) : son
// historique survit au départ de ses membres — la prochaine notification les
// réinscrit de toute façon.
export function isSupportChannel(channel: Pick<Channel, "isDirect" | "name">) {
  return !channel.isDirect && channel.name === supportChannelName();
}

// Son nom lui est donc réservé (409 reserved_name) : aucun salon ne le prend, ni
// à la création ni au renommage, et lui n'en change pas. Un salon qui le
// prendrait perdrait ses admins du salon — un simple membre pourrait en évincer
// l'admin, puis hériter du rôle une fois le nom rendu — et le pipeline pourrait
// l'adopter (membres remplacés par les admins du chat, historique privé
// compris) ; le salon du pipeline renommé deviendrait un salon géré sans admin.
function renamesAcrossPipeline(channel: Pick<Channel, "isDirect" | "name">, name: string) {
  return isSupportChannel({ isDirect: false, name }) !== isSupportChannel(channel);
}

// Un « salon géré » : le seul où existent des admins du salon (Membership.role).
// Jamais une conversation directe ni d'expert, ni « Général » (géré par les
// admins du chat seuls), ni le salon du pipeline (ses membres sont les admins du
// chat, réconciliés à chaque notification — voir notify.ts).
export function isManagedSalon(
  channel: Pick<Channel, "isDirect" | "kind" | "isDefault" | "name">
) {
  return (
    !channel.isDirect &&
    channel.kind === "standard" &&
    !channel.isDefault &&
    !isSupportChannel(channel)
  );
}

// Un admin du salon n'a la main que tant que son compte est actif (1.6.2).
// Désactivé, il garde son rôle — il le retrouve s'il est réactivé — mais ne
// compte plus : ni dans `adminIds`, ni comme dernier admin, ni pour se protéger
// d'un retrait par un simple membre. Un salon n'a donc jamais pour seul admin
// un compte que personne ne peut plus utiliser.
const ACTIVE_ADMIN = {
  role: "admin",
  user: { status: "active" },
} satisfies Prisma.MembershipWhereInput;

// Ceux qui peuvent reprendre un salon : des personnes au compte actif — jamais
// le bot technique, qui ne lit rien. Une fonction, pas une constante : ce
// module et notify.ts (BOT_USERNAME) s'importent l'un l'autre, et quand
// notify.ts est chargé le premier, ce module s'évalue avant que BOT_USERNAME
// existe.
function activePerson() {
  return {
    username: { not: BOT_USERNAME },
    status: "active",
  } satisfies Prisma.UserWhereInput;
}

// Admins d'un salon, tels que les voient les clients (`adminIds`) : toujours
// vide hors d'un salon géré, quoi que dise la colonne, et sans les comptes
// désactivés.
function salonAdminIds(
  channel: Channel & { memberships?: (Membership & { user: Pick<User, "status"> })[] | null }
) {
  if (!isManagedSalon(channel)) return [];
  return (channel.memberships || [])
    .filter((m) => m.role === "admin" && m.user.status === "active")
    .map((m) => m.userId);
}

function isSalonAdmin(channel: Channel, membership: Pick<Membership, "role"> | null) {
  return isManagedSalon(channel) && membership?.role === "admin";
}

// Administrer un salon (changer sa visibilité, le supprimer, nommer ou retirer
// ses admins, en exclure un admin) : un admin du salon, ou un admin du chat — qui
// garde la main partout, salon public dont il n'est pas membre compris. Un salon
// privé, lui, n'existe toujours pas pour un non-membre (findManageable).
function canAdminister(
  req: Express.Request,
  channel: Channel,
  membership: Pick<Membership, "role"> | null
) {
  return !!req.user?.isAdmin || isSalonAdmin(channel, membership);
}

// Lu après le nom du membre promu, auteur du message de service : « Bob est
// maintenant admin du salon » (promotion automatique, ou admin du chat qui se
// nomme lui-même).
const NOW_ADMIN_TEXT = "est maintenant admin du salon";

// Verrouille la ligne du salon jusqu'à la fin de la transaction : les
// changements de rôle d'un même salon (nomination, retrait du rôle, promotion
// automatique) passent l'un après l'autre. Sans cela, deux admins qui se
// retirent le rôle au même instant se croiraient chacun « pas le dernier », et
// le salon finirait sans admin. NO KEY UPDATE et non UPDATE : les messages et
// adhésions qui arrivent entre-temps (contrôle de clé étrangère) ne sont pas
// retenus.
async function lockSalon(tx: Prisma.TransactionClient, channelId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Channel" WHERE "id" = ${channelId} FOR NO KEY UPDATE`;
  return tx.channel.findUnique({ where: { id: channelId } });
}

// Le membre qui reprend un salon resté sans admin actif : le plus ancien membre
// actif. Un compte désactivé ne compterait pas comme admin : faute de membre
// actif, personne n'est nommé — le prochain à revenir (réactivé, ou qui rejoint
// le salon public) le reprendra.
const HEIR_ORDER = [
  { joinedAt: "asc" },
  { id: "asc" },
] satisfies Prisma.MembershipOrderByWithRelationInput[];

async function findHeir(db: Prisma.TransactionClient, channelId: string) {
  return db.membership.findFirst({
    where: { channelId, user: activePerson() },
    orderBy: HEIR_ORDER,
  });
}

// Promeut, sans bruit, un membre d'un salon géré qui n'a plus d'admin actif ;
// renvoie sa membership, ou null s'il n'y avait rien à faire. `preferredUserId`
// (le créateur, au rattrapage du démarrage) passe devant s'il en est encore
// membre, avec un compte actif.
async function promoteHeir(channelId: string, preferredUserId?: string | null) {
  return prisma.$transaction(async (tx) => {
    const channel = await lockSalon(tx, channelId);
    if (!channel || !isManagedSalon(channel)) return null;
    if ((await tx.membership.count({ where: { channelId, ...ACTIVE_ADMIN } })) > 0) return null;
    const preferred = preferredUserId
      ? await tx.membership.findFirst({
          where: { channelId, userId: preferredUserId, user: activePerson() },
        })
      : null;
    const heir = preferred ?? (await findHeir(tx, channelId));
    if (!heir) return null;
    // Le verrou du salon ne couvre pas le statut des comptes : un admin réactivé
    // entre le décompte (encore désactivé) et ce choix (actif) est choisi alors
    // qu'il porte déjà le rôle. Le salon a donc un admin actif : rien à nommer
    // ni à annoncer — il retrouve son rôle en silence, comme toute réactivation.
    if (heir.role === "admin") return null;
    // updateMany : le successeur a pu partir à l'instant — son propre départ
    // repasse par ensureSalonAdmin, qui en désignera un autre.
    const { count } = await tx.membership.updateMany({
      where: { id: heir.id },
      data: { role: "admin" },
    });
    return count > 0 ? heir : null;
  });
}

// Invariant des salons gérés : tant qu'il y reste un membre actif (hors bot), il
// y a au moins un admin du salon actif. Appelé après chaque départ (quitter,
// être retiré, compte purgé) et chaque changement de statut d'un compte : si le
// dernier admin actif est parti, le plus ancien membre actif le devient, ce que
// le salon voit (`channel:members`, et avec `announce` un message de service à
// son nom). Sans effet partout ailleurs.
export async function ensureSalonAdmin(
  io: Server | null | undefined,
  channelId: string,
  { announce = false }: { announce?: boolean } = {}
) {
  const heir = await promoteHeir(channelId);
  if (!heir) return null;
  await broadcastMembers(io, channelId);
  if (announce) await postSystemMessage(io, channelId, heir.userId, NOW_ADMIN_TEXT);
  return heir;
}

// Rattrapage au démarrage, pour les salons antérieurs aux admins du salon et
// tout salon resté sans admin actif (dont ceux qu'une 1.6.1 laissait à un
// compte désactivé) : chacun reçoit le sien — son créateur s'il en est encore
// membre actif, sinon le plus ancien membre actif. En silence : aucun membre
// n'a rien fait, il n'y a pas de message de service. Mais le serveur écoute
// déjà : un client reconnecté avant la fin du rattrapage a reçu des `adminIds`
// vides, `channel:members` les lui met à jour. Idempotent, sans effet une fois
// fait. Renvoie le nombre de salons pourvus.
export async function ensureSalonAdmins(io?: Server | null) {
  const salons = await prisma.channel.findMany({
    where: {
      isDirect: false,
      kind: "standard",
      isDefault: false,
      memberships: {
        none: ACTIVE_ADMIN,
        some: { user: activePerson() },
      },
    },
    select: { id: true, name: true, isDirect: true, kind: true, isDefault: true, createdById: true },
  });
  let promoted = 0;
  for (const salon of salons) {
    // Le salon du pipeline se reconnaît à son nom : filtré ici plutôt qu'en SQL.
    if (!isManagedSalon(salon)) continue;
    if (!(await promoteHeir(salon.id, salon.createdById))) continue;
    promoted += 1;
    await broadcastMembers(io, salon.id);
  }
  return promoted;
}

// Un compte désactivé ou réactivé (panneau d'admin) change les admins qui
// comptent dans ses salons gérés. Désactivé, il n'y a plus la main : là où il
// était le dernier admin actif, le plus ancien membre actif prend le relais,
// annoncé comme au départ d'un admin. Réactivé, il retrouve son rôle — ou
// reprend un salon resté sans admin actif faute d'autre membre actif. Là où il
// est admin, ses `adminIds` changent avec lui : le salon les reçoit à jour.
// Rien ne remonte à l'admin du chat : il ne voit toujours pas les salons privés.
export async function syncSalonAdminsOf(io: Server | null | undefined, userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: {
      role: true,
      channel: { select: { id: true, name: true, isDirect: true, kind: true, isDefault: true } },
    },
  });
  // Un salon après l'autre : chaque vérification est une courte transaction qui
  // verrouille le sien (promoteHeir).
  for (const { role, channel } of memberships) {
    if (!isManagedSalon(channel)) continue;
    const heir = await ensureSalonAdmin(io, channel.id, { announce: true });
    if (!heir && role === "admin") await broadcastMembers(io, channel.id);
  }
}

// Un salon privé sans plus aucun membre (le bot technique ne compte pas : il ne
// lit rien) n'est plus visible de personne, ni supprimable par un admin — il
// est supprimé avec son contenu. Renvoie true s'il l'a été.
export async function destroyIfAbandoned(io: Server | null | undefined, channel: Channel) {
  if (!channel.isPrivate || channel.isDefault || isSupportChannel(channel)) return false;
  const people = await prisma.membership.count({
    where: { channelId: channel.id, user: { username: { not: BOT_USERNAME } } },
  });
  if (people > 0) return false;
  await destroyChannel(io, channel.id);
  return true;
}

// Un message livré dans une conversation directe la fait revenir chez ceux qui
// l'avaient masquée, sur tous leurs appareils. Sans cela, `hiddenAt` resterait
// posé : supprimer ensuite le dernier message la ferait disparaître de nouveau.
export async function unhideConversation(io: Server | null | undefined, channelId: string) {
  const hidden = await prisma.membership.findMany({
    where: { channelId, hiddenAt: { not: null } },
    select: { userId: true },
  });
  if (hidden.length === 0) return;
  await prisma.membership.updateMany({
    where: { channelId, hiddenAt: { not: null } },
    data: { hiddenAt: null },
  });
  for (const { userId } of hidden) {
    io?.to(`user:${userId}`).emit("channel:hidden", { channelId, hiddenAt: null });
  }
}

// Retire un membre (départ, exclusion, admin rétrogradé du salon du pipeline) :
// membership, messages programmés qui n'y partiront plus (et leurs fichiers), et
// abonnements temps réel — ses sockets quittent la room, ses appareils retirent
// le salon de leur liste.
export async function removeMember(
  io: Server | null | undefined,
  channelId: string,
  userId: string,
  info?: RemovalInfo
) {
  const pending = await prisma.message.findMany({
    where: { channelId, authorId: userId, delivered: false },
    include: { attachments: { select: { storagePath: true } } },
  });
  await prisma.$transaction([
    prisma.membership.deleteMany({ where: { channelId, userId } }),
    prisma.message.deleteMany({ where: { id: { in: pending.map((m) => m.id) } } }),
  ]);
  await Promise.all(
    pending.flatMap((m) => m.attachments).map((a) => safeUnlink(a.storagePath))
  );
  io?.to(`user:${userId}`).emit("channel:removed", { channelId, ...info });
  io?.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);
  await broadcastMembers(io, channelId);
}

// Un salon que l'appelant peut gérer, ni DM ni conversation d'expert. Un salon
// PRIVÉ n'existe que pour ses membres, admins compris : sans en être membre, il
// répond comme s'il n'existait pas (null → 404).
async function findManageable(channelId: string, userId: string) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel || channel.isDirect || channel.kind === "claude") return null;
  const membership = await prisma.membership.findUnique({
    where: { userId_channelId: { userId, channelId } },
  });
  if (channel.isPrivate && !membership) return null;
  return { channel, membership };
}

// Personnes qu'on peut ajouter à un salon : des comptes actifs, jamais le bot
// technique « Claude » (auteur des messages des experts et du pipeline).
async function addableUsers(ids: unknown[]) {
  const wanted = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (wanted.length === 0) return [];
  return prisma.user.findMany({
    where: { id: { in: wanted }, status: "active", username: { not: BOT_USERNAME } },
  });
}

router.get("/", requireAuth, async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.userId },
    include: {
      channel: {
        include: {
          memberships: { include: { user: true } },
          // Un message masqué par l'appelant ne compte pas comme dernier
          // message : il ne doit pas rendre le salon « non lu ». Un message de
          // service non plus (LAST_MESSAGE_WHERE).
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            where: { ...LAST_MESSAGE_WHERE, hiddenBy: { none: { userId: req.userId } } },
          },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  const channels = memberships.map((m) => serializeChannel(m.channel, req.userId));
  res.json({ channels });
});

const createChannelSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  isPrivate: z.boolean().optional(),
  memberIds: z.array(z.string()).optional(),
});

router.post("/", requireAuth, async (req, res) => {
  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, description, isPrivate, memberIds = [] } = parsed.data;
  // Le nom du salon du pipeline lui est réservé (voir renamesAcrossPipeline).
  if (isSupportChannel({ isDirect: false, name: name.trim() })) {
    return res.status(409).json({ error: "reserved_name" });
  }
  const channel = await createSalon(req, {
    name: name.trim(),
    description,
    isPrivate: !!isPrivate,
    memberIds: (await addableUsers(memberIds)).map((u) => u.id),
  });
  res.json({ channel: serializeChannel(channel, req.userId) });
});

// Crée un salon avec l'appelant et `memberIds`, et l'annonce à chacun : les
// personnes ajoutées par l'appelant reçoivent `addedBy` (leur client le signale).
// Le créateur en est l'admin du salon, les autres de simples membres — sauf sous
// le nom du salon du pipeline (que POST /channels refuse), qui n'a pas d'admins
// du salon.
async function createSalon(
  req: Express.Request,
  data: { name: string; description?: string; isPrivate: boolean; memberIds: string[] }
) {
  const allMembers = Array.from(new Set([req.userId, ...data.memberIds]));
  const creatorRole = isSupportChannel({ isDirect: false, name: data.name }) ? "member" : "admin";
  const channel = await prisma.channel.create({
    data: {
      name: data.name,
      description: data.description,
      isPrivate: data.isPrivate,
      isDirect: false,
      createdById: req.userId,
      memberships: {
        create: allMembers.map((userId) => ({
          userId,
          role: userId === req.userId ? creatorRole : "member",
        })),
      },
    },
    include: CHANNEL_INCLUDE,
  });
  const addedBy = req.user ? { id: req.user.id, displayName: req.user.displayName } : undefined;
  for (const m of channel.memberships) {
    const personalized = serializeChannel(channel, m.userId);
    req.io
      ?.to(`user:${m.userId}`)
      .emit("channel:created", m.userId === req.userId ? personalized : { ...personalized, addedBy });
    req.io?.in(`user:${m.userId}`).socketsJoin(`channel:${channel.id}`);
  }
  // Créateur désactivé pendant la création (sa requête avait passé
  // l'authentification) : syncSalonAdminsOf, qui ne voyait pas encore ce salon,
  // est relayé ici. L'une des deux vérifications voit toujours l'autre : le
  // salon ne garde pas pour seul admin un compte désactivé.
  await ensureSalonAdmin(req.io, channel.id, { announce: true });
  return channel;
}

router.post("/dm", requireAuth, async (req, res) => {
  const body = req.body || {};
  // `req.body` n'est pas typé (JSON arbitraire) : on annote la cible attendue,
  // le filtre `id && id !== req.userId` ci-dessous reste la vraie validation.
  let ids: string[] = Array.isArray(body.userIds)
    ? body.userIds
    : body.userId
    ? [body.userId]
    : [];
  // We DO keep the caller's own id this time: a DM with just yourself is the
  // "notes pour soi" scratchpad. So `userIds=[]` and `userIds=[self]` both
  // resolve to the same single-member self-DM, and the others stay 2+ members.
  const isSelfOnly = ids.length === 0 || ids.every((id) => id === req.userId);
  ids = [...new Set(ids.filter((id) => id && id !== req.userId))];
  if (ids.length === 0 && !isSelfOnly) {
    return res.status(400).json({ error: "invalid_target" });
  }

  if (ids.length) {
    const found = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      return res.status(400).json({ error: "invalid_target" });
    }
  }

  // Always include the caller. For a self-DM, that's the *only* member.
  const targetIds = [...new Set([req.userId, ...ids])];

  // Plusieurs personnes : depuis la 1.6.0, un groupe est un salon privé géré par
  // ses membres. Les clients à jour passent par POST /channels ; un client
  // antérieur (desktop pas encore mis à jour, app Android) arrive ici avec son
  // « Créer le groupe » : comme avant, on rouvre le groupe qui réunit déjà
  // exactement ces personnes plutôt que d'en créer un double.
  if (ids.length >= 2) {
    const candidates = await prisma.channel.findMany({
      where: {
        isDirect: false,
        isPrivate: true,
        isDefault: false,
        kind: "standard",
        NOT: { name: supportChannelName() },
        AND: targetIds.map((uid) => ({ memberships: { some: { userId: uid } } })),
      },
      include: CHANNEL_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    const existing = candidates.find((c) => c.memberships.length === targetIds.length);
    if (existing) return res.json({ channel: serializeChannel(existing, req.userId) });
    const members = await addableUsers(ids);
    if (members.length !== ids.length) return res.status(400).json({ error: "invalid_target" });
    const channel = await createSalon(req, {
      name: defaultSalonName([req.user?.displayName || "", ...members.map((u) => u.displayName)]),
      isPrivate: true,
      memberIds: members.map((u) => u.id),
    });
    return res.json({ channel: serializeChannel(channel, req.userId) });
  }

  // Réutiliser un DM existant avec exactement le même ensemble de membres
  const candidates = await prisma.channel.findMany({
    where: {
      isDirect: true,
      AND: targetIds.map((uid) => ({ memberships: { some: { userId: uid } } })),
    },
    include: { memberships: { select: { userId: true, hiddenAt: true } } },
  });
  const existing = candidates.find((c) => c.memberships.length === targetIds.length);
  if (existing) {
    // Rouvrir une conversation masquée la remet dans la liste, sur tous les
    // appareils de l'appelant.
    if (existing.memberships.some((m) => m.userId === req.userId && m.hiddenAt)) {
      await prisma.membership.update({
        where: { userId_channelId: { userId: req.userId, channelId: existing.id } },
        data: { hiddenAt: null },
      });
      req.io
        ?.to(`user:${req.userId}`)
        .emit("channel:hidden", { channelId: existing.id, hiddenAt: null });
    }
    const full = await prisma.channel.findUnique({
      where: { id: existing.id },
      include: CHANNEL_INCLUDE,
    });
    return res.json({ channel: serializeChannel(full!, req.userId) });
  }

  const channel = await prisma.channel.create({
    data: {
      isDirect: true,
      memberships: { create: targetIds.map((userId) => ({ userId })) },
    },
    include: CHANNEL_INCLUDE,
  });
  for (const m of channel.memberships) {
    const personalized = serializeChannel(channel, m.userId);
    req.io?.to(`user:${m.userId}`).emit("channel:created", personalized);
    req.io?.in(`user:${m.userId}`).socketsJoin(`channel:${channel.id}`);
  }
  res.json({ channel: serializeChannel(channel, req.userId) });
});

router.get("/:id/messages", requireAuth, async (req, res) => {
  const { id } = req.params;
  const member = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: id } },
  });
  if (!member) return res.status(403).json({ error: "not_a_member" });

  // Discord/Messenger model: replies live inline in the timeline alongside
  // root messages, with a quote of the parent rendered above each reply.
  // (Old Slack-thread model filtered out anything with parentId.)
  // Pagination par curseur, du plus récent vers le plus ancien. Par défaut on
  // renvoie les 200 messages les PLUS RÉCENTS ; `?before=<messageId>` charge les
  // 200 antérieurs à ce message (curseur Prisma stable grâce au tie-break sur
  // l'id). On récupère PAGE+1 lignes pour savoir s'il reste du plus ancien, puis
  // on renvoie la page triée du plus ancien au plus récent (ordre d'affichage).
  const PAGE = 200;
  const before = typeof req.query.before === "string" ? req.query.before : null;
  const rows = await prisma.message.findMany({
    // Les messages que l'appelant a masqués (« Supprimer pour moi ») sont
    // écartés ici, donc aussi du curseur : `oldestId` est toujours visible.
    where: { channelId: id, delivered: true, hiddenBy: { none: { userId: req.userId } } },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
      // Hydrate the parent (author + body for the quote bubble). Cheap because
      // we only ever go one level deep — replies-to-replies are rejected at
      // send time.
      parent: {
        include: {
          author: true,
          hiddenBy: { where: { userId: req.userId }, select: { id: true } },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
  });
  const hasMore = rows.length > PAGE;
  const page = rows.slice(0, PAGE); // plus récent -> plus ancien
  const oldestId = page.length ? page[page.length - 1].id : null;

  // Frontière de lecture : le plus ancien message non lu par l'appelant (posté
  // après son `lastReadAt`, et pas par lui-même). Le client s'y positionne à
  // l'ouverture (« premier message non lu »). Calculée ICI, à partir du
  // `lastReadAt` courant, AVANT tout marquage comme lu — celui-ci passe par le
  // socket `channel:read`, que le client n'émet qu'après avoir reçu cette réponse.
  // Uniquement pour le chargement initial (pas la pagination `before`).
  let firstUnreadId = null;
  if (!before && member.lastReadAt) {
    const fu = await prisma.message.findFirst({
      where: {
        channelId: id,
        ...LAST_MESSAGE_WHERE,
        createdAt: { gt: member.lastReadAt },
        NOT: { authorId: req.userId },
        hiddenBy: { none: { userId: req.userId } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    firstUnreadId = fu?.id || null;
  }

  res.json({
    // plus ancien -> plus récent. Une réponse à un message masqué perd sa
    // citation, qui en montrerait le contenu (comme côté client au masquage).
    messages: page
      .reverse()
      .map((m) =>
        serializeMessage(m.parent?.hiddenBy.length ? { ...m, parentId: null, parent: null } : m)
      ),
    hasMore,
    nextCursor: hasMore ? oldestId : null,
    firstUnreadId,
  });
});

router.get("/:id/scheduled", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!(await isMember(req.userId, id))) return res.status(403).json({ error: "not_a_member" });
  const scheduled = await prisma.message.findMany({
    where: {
      channelId: id,
      authorId: req.userId,
      delivered: false,
      scheduledAt: { not: null },
    },
    include: { attachments: true },
    orderBy: { scheduledAt: "asc" },
  });
  res.json({ scheduled: scheduled.map(serializeScheduled) });
});

// Same blob-cleanup logic as the regular delete: scheduled messages also carry
// attachments we want to remove from disk immediately on cancel.
router.delete("/scheduled/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { attachments: true },
  });
  if (!msg || msg.authorId !== req.userId || msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }
  const blobs = (msg.attachments || []).map((a) => a.storagePath);
  await prisma.message.delete({ where: { id: messageId } });
  await Promise.all(blobs.map((p) => safeUnlink(p)));
  res.json({ ok: true });
});

router.patch("/scheduled/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const { body, scheduledAt } = req.body || {};

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.authorId !== req.userId || msg.delivered) {
    return res.status(404).json({ error: "not_found" });
  }
  if (!(await isMember(req.userId, msg.channelId))) {
    return res.status(403).json({ error: "not_a_member" });
  }

  const data: Prisma.MessageUpdateInput = {};
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return res.status(400).json({ error: "empty_body" });
    data.body = encryptBody(trimmed);
    data.searchableBody = trimmed; // keep the FTS index in sync
  }
  if (scheduledAt !== undefined) {
    const date = new Date(scheduledAt);
    if (isNaN(date.getTime()) || date.getTime() <= Date.now() + 1000) {
      return res.status(400).json({ error: "scheduled_at_must_be_future" });
    }
    data.scheduledAt = date;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "nothing_to_update" });
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data,
    include: { attachments: true },
  });
  res.json({ scheduled: serializeScheduled(updated) });
});

router.patch("/messages/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const { body } = req.body || {};

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  // Un message de service (« a ajouté Bob ») n'est pas un texte de son auteur.
  if (!msg || msg.authorId !== req.userId || !msg.delivered || msg.kind === "system") {
    return res.status(404).json({ error: "not_found" });
  }
  // Retiré du salon (privé ou non) : plus aucune écriture, pas même sur ses
  // anciens messages — l'édition serait diffusée à tout le salon.
  if (!(await isMember(req.userId, msg.channelId))) {
    return res.status(403).json({ error: "not_a_member" });
  }

  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) return res.status(400).json({ error: "empty_body" });

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      body: encryptBody(trimmed),
      // Plaintext FTS mirror; see schema note on the privacy trade-off.
      searchableBody: trimmed,
      editedAt: new Date(),
    },
    include: {
      author: true,
      attachments: true,
      reactions: { include: { user: true } },
      // Re-hydrate the parent so the inline quote survives the edit. Without it,
      // serializeMessage emits parent:null and clients drop the quote bubble
      // until a reload re-fetches via GET /messages (which already includes it).
      parent: { include: { author: true } },
    },
  });

  const serialized = serializeMessage(updated);
  req.io?.to(`channel:${updated.channelId}`).emit("message:updated", serialized);
  res.json({ message: serialized });
});

router.delete("/messages/:messageId", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  // Pre-fetch attachments (own + via cascaded replies) so we can unlink the
  // blobs on disk after the DB cascade removes their rows. The sweep worker
  // is the safety net; this is the happy path.
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      attachments: true,
      replies: { include: { attachments: true } },
    },
  });
  if (!msg || msg.authorId !== req.userId || !msg.delivered || msg.kind === "system") {
    return res.status(404).json({ error: "not_found" });
  }
  if (!(await isMember(req.userId, msg.channelId))) {
    return res.status(403).json({ error: "not_a_member" });
  }
  const blobs = [
    ...msg.attachments,
    ...(msg.replies || []).flatMap((r) => r.attachments || []),
  ].map((a) => a.storagePath);
  const { channelId, parentId } = msg;
  await prisma.message.delete({ where: { id: messageId } });
  await Promise.all(blobs.map((p) => safeUnlink(p)));
  req.io
    ?.to(`channel:${channelId}`)
    .emit("message:deleted", { id: messageId, channelId, parentId });
  res.json({ ok: true });
});

// « Supprimer pour moi » : masque un message pour l'appelant seul, sur tous ses
// appareils ; il reste intact pour les autres membres. Ouvert à tout membre,
// quel que soit l'auteur — c'est ce qui permet de retirer le message d'un autre.
router.post("/messages/:messageId/hide", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || !msg.delivered) return res.status(404).json({ error: "not_found" });
  if (!(await isMember(req.userId, msg.channelId))) {
    return res.status(403).json({ error: "not_a_member" });
  }
  // Idempotent (double clic, deux appareils) : un doublon est ignoré.
  await prisma.hiddenMessage.createMany({
    data: [{ userId: req.userId, messageId }],
    skipDuplicates: true,
  });
  req.io
    ?.to(`user:${req.userId}`)
    .emit("message:hidden", { id: messageId, channelId: msg.channelId });
  res.json({ ok: true });
});

router.post("/messages/:messageId/reactions", requireAuth, async (req, res) => {
  const { messageId } = req.params;
  const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.trim() : "";
  if (!emoji || emoji.length > 32) {
    return res.status(400).json({ error: "invalid_emoji" });
  }

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.kind === "system") return res.status(404).json({ error: "not_found" });
  const member = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: msg.channelId } },
  });
  if (!member) return res.status(403).json({ error: "not_a_member" });

  const existing = await prisma.reaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId: req.userId, emoji } },
  });
  if (existing) {
    await prisma.reaction.delete({ where: { id: existing.id } });
  } else {
    await prisma.reaction.create({ data: { messageId, userId: req.userId, emoji } });
  }

  const reactions = await prisma.reaction.findMany({
    where: { messageId },
    include: { user: true },
  });
  const grouped = groupReactions(reactions);
  req.io
    ?.to(`channel:${msg.channelId}`)
    .emit("reaction:update", { messageId, reactions: grouped });
  res.json({ messageId, reactions: grouped });
});

router.get("/public", requireAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const channels = await prisma.channel.findMany({
    where: {
      isDirect: false,
      isPrivate: false,
      memberships: { none: { userId: req.userId } },
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    include: CHANNEL_INCLUDE,
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  res.json({ channels: channels.map((c) => serializeChannel(c, req.userId)) });
});

router.post("/:id/join", requireAuth, async (req, res) => {
  const { id } = req.params;
  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel || channel.isDirect || channel.isPrivate) {
    return res.status(404).json({ error: "not_found" });
  }
  const joined = await prisma.membership.createMany({
    data: [{ userId: req.userId, channelId: id }],
    skipDuplicates: true,
  });
  // Un salon public resté sans admin (vidé par ses membres) en retrouve un : le
  // plus ancien membre, donc celui qui arrive s'il est seul. C'est ensureSalonAdmin
  // en deux temps : promu AVANT de servir le salon, pour que channel:created et
  // la réponse le disent (le client remplace sa copie par la réponse) ; annoncé
  // APRÈS « a rejoint le salon », dans l'ordre des faits.
  const heir = await promoteHeir(id);
  const full = await prisma.channel.findUnique({ where: { id }, include: CHANNEL_INCLUDE });
  const personalized = serializeChannel(full!, req.userId);
  req.io?.to(`user:${req.userId}`).emit("channel:created", personalized);
  req.io?.in(`user:${req.userId}`).socketsJoin(`channel:${id}`);
  await broadcastMembers(req.io, id);
  if (joined.count > 0) await postSystemMessage(req.io, id, req.userId, "a rejoint le salon");
  if (heir) await postSystemMessage(req.io, id, heir.userId, NOW_ADMIN_TEXT);
  res.json({ channel: personalized });
});

// Tout membre d'un salon peut y ajouter des personnes (1.6.0). Elles voient tout
// l'historique, comme dans un salon public — le client le rappelle avant l'ajout.
router.post("/:id/members", requireAuth, async (req, res) => {
  const { id } = req.params;
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  if (userIds.length === 0) return res.status(400).json({ error: "no_users" });

  // Les conversations de l'expert Claude (kind "claude") sont figées à
  // {utilisateur, bot} : ni ajout, ni départ, ni retrait de membre.
  const found = await findManageable(id, req.userId);
  if (!found) return res.status(404).json({ error: "not_found" });
  if (!found.membership) return res.status(403).json({ error: "not_a_member" });

  const existing = await prisma.membership.findMany({
    where: { channelId: id },
    select: { userId: true },
  });
  const already = new Set(existing.map((m) => m.userId));
  const added = (await addableUsers(userIds)).filter((u) => !already.has(u.id));
  await prisma.membership.createMany({
    data: added.map((u) => ({ userId: u.id, channelId: id })),
    skipDuplicates: true,
  });

  const full = await prisma.channel.findUnique({ where: { id }, include: CHANNEL_INCLUDE });
  const addedBy = req.user ? { id: req.user.id, displayName: req.user.displayName } : undefined;
  for (const u of added) {
    const personalized = serializeChannel(full!, u.id);
    req.io?.to(`user:${u.id}`).emit("channel:created", { ...personalized, addedBy });
    req.io?.in(`user:${u.id}`).socketsJoin(`channel:${id}`);
  }
  await broadcastMembers(req.io, id);
  if (added.length) {
    const names = joinNames(added.map((u) => u.displayName));
    await postSystemMessage(req.io, id, req.userId, `a ajouté ${names} au salon`);
    // Celui qui ajoute, désactivé pendant l'ajout (sa requête avait passé
    // l'authentification) : syncSalonAdminsOf ne voyait pas encore les
    // arrivants, l'un d'eux reprend ici le salon resté sans admin actif. Comme
    // à la création, l'une des deux vérifications voit toujours l'autre.
    await ensureSalonAdmin(req.io, id, { announce: true });
  }
  res.json({ channel: serializeChannel(full!, req.userId) });
});

// Départ volontaire. Le dernier membre qui quitte un salon privé le supprime :
// plus personne ne pourrait le voir (un salon public, lui, reste à rejoindre).
// Tout le monde peut partir, le dernier admin du salon compris : le plus ancien
// membre restant prend alors le relais.
async function leaveSalon(req: Express.Request, channel: Channel) {
  await removeMember(req.io, channel.id, req.userId, {
    reason: "left",
    channelName: channel.name,
  });
  if (await destroyIfAbandoned(req.io, channel)) return;
  const remaining = await prisma.membership.count({ where: { channelId: channel.id } });
  // Personne pour lire un « a quitté le salon » (salon public resté vide).
  if (remaining === 0) return;
  await postSystemMessage(req.io, channel.id, req.userId, "a quitté le salon");
  await ensureSalonAdmin(req.io, channel.id, { announce: true });
}

router.post("/:id/leave", requireAuth, async (req, res) => {
  const found = await findManageable(req.params.id, req.userId);
  if (!found) return res.status(404).json({ error: "not_found" });
  if (found.channel.isDefault) return res.status(403).json({ error: "cannot_leave_default" });
  if (found.membership) await leaveSalon(req, found.channel);
  res.json({ ok: true });
});

// Tout membre peut retirer un simple membre du salon ; retirer un admin du salon
// revient à qui administre le salon — sans quoi n'importe quel membre pourrait
// évincer ceux qui le gèrent. La personne retirée apprend qui l'a fait, et le
// salon en garde la trace (message de service).
router.delete("/:id/members/:userId", requireAuth, async (req, res) => {
  const { id, userId } = req.params;
  const found = await findManageable(id, req.userId);
  if (!found) return res.status(404).json({ error: "not_found" });
  const { channel, membership } = found;
  if (channel.isDefault) {
    return res.status(403).json({ error: "cannot_remove_from_default" });
  }
  if (!membership) return res.status(403).json({ error: "not_a_member" });
  if (userId === req.userId) {
    await leaveSalon(req, channel);
    return res.json({ ok: true });
  }
  const target = await prisma.membership.findUnique({
    where: { userId_channelId: { userId, channelId: id } },
    include: { user: true },
  });
  if (!target) return res.status(404).json({ error: "not_a_member" });
  // Un compte désactivé n'a plus la main : admin ou non, il se retire comme un
  // simple membre (un admin actif tient le salon à sa place).
  const targetHolds = isSalonAdmin(channel, target) && target.user.status === "active";
  if (targetHolds && !canAdminister(req, channel, membership)) {
    return res.status(403).json({ error: "admin_only" });
  }
  await removeMember(req.io, id, userId, {
    reason: "removed",
    by: req.user ? { id: req.user.id, displayName: req.user.displayName } : undefined,
    channelName: channel.name,
  });
  // Deux membres qui se retirent l'un l'autre au même instant : personne ne reste.
  if (await destroyIfAbandoned(req.io, channel)) return res.json({ ok: true });
  await postSystemMessage(
    req.io,
    id,
    req.userId,
    `a retiré ${target.user.displayName} du salon`
  );
  // Un admin du chat qui retire le dernier admin du salon : le plus ancien membre
  // prend le relais. Vérifié après tout retrait, pas seulement celui d'un admin :
  // la personne retirée a pu être désignée successeur à l'instant même.
  await ensureSalonAdmin(req.io, id, { announce: true });
  res.json({ ok: true });
});

// Nommer un admin du salon, ou lui retirer le rôle : réservé à qui administre le
// salon (un admin du salon, ou un admin du chat — même sans en être membre s'il
// est public). Le dernier admin ne peut pas se retirer le rôle : un salon géré en
// garde toujours au moins un, il nomme d'abord quelqu'un d'autre (ou part — le
// plus ancien membre prend alors le relais).
const memberRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

type MemberWithUser = Membership & { user: User };

// Issue d'un changement de rôle, décidée sous le verrou du salon.
type RoleChange =
  | { status: 403 | 404 | 409; error: string }
  | { status: 200; target: MemberWithUser; changed: boolean };

// Lu après le nom de l'auteur du changement, sans accord : « Alice a nommé Bob
// admin du salon », « Alice n'est plus admin du salon ».
function roleChangeText(actorId: string, target: MemberWithUser, role: string) {
  const self = target.userId === actorId;
  if (role === "admin") {
    return self ? NOW_ADMIN_TEXT : `a nommé ${target.user.displayName} admin du salon`;
  }
  return self ? "n'est plus admin du salon" : `a retiré le rôle d'admin à ${target.user.displayName}`;
}

router.patch("/:id/members/:userId", requireAuth, async (req, res) => {
  const parsed = memberRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { role } = parsed.data;
  const { id, userId } = req.params;

  const found = await findManageable(id, req.userId);
  if (!found) return res.status(404).json({ error: "not_found" });
  const { channel, membership } = found;
  if (!isManagedSalon(channel)) return res.status(403).json({ error: "no_roles" });
  if (!canAdminister(req, channel, membership)) {
    return res.status(403).json({ error: membership ? "admin_only" : "not_a_member" });
  }

  // Contrôle et écriture sous le verrou du salon (lockSalon) : deux retraits de
  // rôle simultanés ne peuvent pas laisser le salon sans admin.
  const outcome = await prisma.$transaction(async (tx): Promise<RoleChange> => {
    if (!(await lockSalon(tx, id))) return { status: 404, error: "not_found" };
    const target = await tx.membership.findUnique({
      where: { userId_channelId: { userId, channelId: id } },
      include: { user: true },
    });
    if (!target) return { status: 404, error: "not_a_member" };
    // Le bot technique ne lit rien : il ne peut pas tenir un salon. Un compte
    // désactivé non plus : il ne compterait pas comme admin.
    if (role === "admin" && target.user.username === BOT_USERNAME) {
      return { status: 403, error: "bot_protected" };
    }
    if (role === "admin" && target.user.status !== "active") {
      return { status: 403, error: "target_disabled" };
    }
    // Seul le dernier admin ACTIF garde son rôle de force : celui d'un compte
    // désactivé, qui ne compte plus, se retire librement.
    if (role === "member" && target.role === "admin" && target.user.status === "active") {
      const others = await tx.membership.count({
        where: { channelId: id, ...ACTIVE_ADMIN, id: { not: target.id } },
      });
      if (others === 0) return { status: 409, error: "last_admin" };
    }
    if (target.role === role) return { status: 200, target, changed: false };
    const { count } = await tx.membership.updateMany({ where: { id: target.id }, data: { role } });
    // Parti entre la lecture et l'écriture.
    if (count === 0) return { status: 404, error: "not_a_member" };
    return { status: 200, target, changed: true };
  });
  if (outcome.status !== 200) return res.status(outcome.status).json({ error: outcome.error });

  if (outcome.changed) {
    await broadcastMembers(req.io, id);
    await postSystemMessage(req.io, id, req.userId, roleChangeText(req.userId, outcome.target, role));
  }
  const full = await prisma.channel.findUnique({ where: { id }, include: CHANNEL_INCLUDE });
  if (!full) return res.status(404).json({ error: "not_found" });
  res.json({ channel: serializeChannel(full, req.userId) });
});

// « Masquer » une conversation directe : elle quitte la liste de l'appelant (sur
// tous ses appareils) jusqu'au prochain message ou jusqu'à ce qu'il la rouvre.
// Elle est marquée lue au passage : un non-lu caché resterait sinon compté dans
// le badge de l'app sans pastille visible. Rien ne change pour l'autre personne ;
// on ne « quitte » pas un DM.
router.post("/:id/hide", requireAuth, async (req, res) => {
  const { id } = req.params;
  const channel = await prisma.channel.findUnique({ where: { id } });
  const membership = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: id } },
  });
  if (!channel || !channel.isDirect || !membership) {
    return res.status(404).json({ error: "not_found" });
  }
  const hiddenAt = new Date();
  await prisma.membership.update({
    where: { id: membership.id },
    data: { hiddenAt, lastReadAt: hiddenAt },
  });
  req.io?.to(`user:${req.userId}`).emit("channel:hidden", { channelId: id, hiddenAt });
  req.io?.to(`user:${req.userId}`).emit("channel:read", { channelId: id });
  res.json({ ok: true, hiddenAt });
});

// Niveau de notification de l'appelant pour ce channel : "all" | "mentions" | "none".
// Stocké sur sa propre Membership ; n'affecte que lui (pas les autres membres).
const notifyLevelSchema = z.object({
  level: z.enum(["all", "mentions", "none"]),
});

router.patch("/:id/notifications", requireAuth, async (req, res) => {
  const parsed = notifyLevelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const membership = await prisma.membership.findUnique({
    where: { userId_channelId: { userId: req.userId, channelId: req.params.id } },
  });
  if (!membership) return res.status(404).json({ error: "not_a_member" });
  await prisma.membership.update({
    where: { id: membership.id },
    data: { notifyLevel: parsed.data.level },
  });
  res.json({ ok: true, notifyLevel: parsed.data.level });
});

// Renommer / décrire un salon : tout membre (1.6.0). Changer sa visibilité :
// qui administre le salon (un admin du salon ou un admin du chat) — rendre
// public un salon privé exposerait tout son historique. Le salon par défaut
// (« Général ») ne se modifie que par un admin du chat et reste public. Un admin
// du chat peut aussi modérer un salon public sans en être membre ; un salon privé
// n'existe que pour ses membres (findManageable).
const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(300).nullable().optional(),
  isPrivate: z.boolean().optional(),
});

router.patch("/:id", requireAuth, async (req, res) => {
  const parsed = updateChannelSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, description, isPrivate } = parsed.data;
  if (name === undefined && description === undefined && isPrivate === undefined) {
    return res.status(400).json({ error: "nothing_to_update" });
  }

  const found = await findManageable(req.params.id, req.userId);
  if (!found) return res.status(404).json({ error: "not_found" });
  const { channel, membership } = found;
  const isAdmin = !!req.user?.isAdmin;
  if (!isAdmin && !membership) return res.status(403).json({ error: "not_a_member" });
  if (channel.isDefault && !isAdmin) return res.status(403).json({ error: "admin_only" });
  const visibilityChange = isPrivate !== undefined && isPrivate !== channel.isPrivate;
  if (visibilityChange) {
    // Le salon par défaut reste public et ne change pas de visibilité.
    if (channel.isDefault) return res.status(403).json({ error: "cannot_make_default_private" });
    if (!canAdminister(req, channel, membership)) {
      return res.status(403).json({ error: "admin_only" });
    }
    // Un salon privé n'existe que pour ses membres : l'admin qui le rendrait
    // privé sans en être le perdrait aussitôt (et un salon vide, tout le monde).
    if (isPrivate && !membership) return res.status(403).json({ error: "not_a_member" });
  }

  const data: Prisma.ChannelUpdateInput = {};
  const renamed = name !== undefined && name !== channel.name;
  if (renamed && renamesAcrossPipeline(channel, name)) {
    return res.status(409).json({ error: "reserved_name" });
  }
  if (renamed) data.name = name;
  if (description !== undefined) {
    const trimmed = typeof description === "string" ? description.trim() : "";
    data.description = trimmed ? trimmed : null;
  }
  if (visibilityChange) data.isPrivate = isPrivate;

  const updated = await prisma.channel.update({
    where: { id: channel.id },
    data,
    include: CHANNEL_INCLUDE,
  });
  // Diffusion personnalisée par membre (notifyLevel / unread diffèrent), comme
  // channel:created : chaque appareil met à jour sa liste sans recharger.
  for (const m of updated.memberships) {
    req.io?.to(`user:${m.userId}`).emit("channel:updated", serializeChannel(updated, m.userId));
  }
  if (renamed) {
    await postSystemMessage(req.io, channel.id, req.userId, `a renommé le salon en « ${name} »`);
  }
  if (visibilityChange) {
    await postSystemMessage(
      req.io,
      channel.id,
      req.userId,
      isPrivate ? "a rendu le salon privé" : "a rendu le salon public"
    );
  }
  res.json({ channel: serializeChannel(updated, req.userId) });
});

// Supprimer un salon et tout son contenu : qui l'administre (un admin du salon ou
// un admin du chat) ; les autres le quittent. Un salon privé n'existe que pour
// ses membres, admins du chat compris : seul un admin du chat qui en est membre
// (ou un de ses admins du salon) peut le supprimer.
router.delete("/:id", requireAuth, async (req, res) => {
  const found = await findManageable(req.params.id, req.userId);
  if (!found) return res.status(404).json({ error: "not_found" });
  const { channel, membership } = found;
  if (channel.isDefault) return res.status(403).json({ error: "cannot_delete_default" });
  if (!canAdminister(req, channel, membership)) {
    return res.status(403).json({ error: membership ? "admin_only" : "not_a_member" });
  }
  await destroyChannel(req.io, channel.id);
  res.json({ ok: true });
});

export function serializeChannel(channel: ChannelWithRelations, viewerId: string) {
  const members = (channel.memberships || []).map((m) => publicUser(m.user));
  let displayName = channel.name;
  if (channel.isDirect) {
    const others = members.filter((u) => u.id !== viewerId);
    // Single-member DM where that member is the viewer = the "notes pour soi"
    // scratchpad. Anything else without other members shouldn't happen in
    // practice but we keep "Direct" as a safe fallback.
    if (others.length === 0) {
      const onlyMe = members.length === 1 && members[0].id === viewerId;
      displayName = onlyMe ? "Mes notes" : "Direct";
    } else {
      displayName = others.map((u) => u.displayName).join(", ");
    }
  }
  const last = channel.messages?.[0];
  const viewerMembership = (channel.memberships || []).find(
    (m) => m.userId === viewerId
  );
  const unread = !!(
    last &&
    last.authorId !== viewerId &&
    viewerMembership?.lastReadAt &&
    new Date(last.createdAt) > new Date(viewerMembership.lastReadAt)
  );
  return {
    id: channel.id,
    name: channel.name,
    displayName,
    isDirect: channel.isDirect,
    isPrivate: channel.isPrivate,
    isDefault: channel.isDefault,
    kind: channel.kind,
    expert: channel.expert,
    description: channel.description,
    createdById: channel.createdById ?? null,
    // Niveau de notification de l'appelant pour ce channel (défaut "all" si la
    // membership n'est pas hydratée, p. ex. juste après une création).
    notifyLevel: viewerMembership?.notifyLevel || "all",
    // Conversation directe masquée par l'appelant (null sinon) : le client la
    // cache tant qu'aucun message n'est arrivé depuis.
    hiddenAt: viewerMembership?.hiddenAt ?? null,
    members,
    // Admins du salon (ids de `members`) : toujours vide hors d'un salon géré —
    // DM, conversation d'expert, « Général », salon du pipeline.
    adminIds: salonAdminIds(channel),
    lastMessage: last
      ? {
          id: last.id,
          body: decryptBody(last.body),
          createdAt: last.createdAt,
          authorId: last.authorId,
        }
      : null,
    unread,
  };
}

export function serializeAttachment(a: Attachment) {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
  };
}

export function groupReactions(reactions?: ReactionWithUser[] | null) {
  const map = new Map();
  for (const r of reactions || []) {
    if (!map.has(r.emoji)) map.set(r.emoji, []);
    map.get(r.emoji).push({ id: r.userId, displayName: r.user?.displayName });
  }
  return Array.from(map, ([emoji, users]) => ({
    emoji,
    count: users.length,
    users,
  }));
}

export function serializeMessage(m: MessageWithRelations) {
  return {
    id: m.id,
    channelId: m.channelId,
    // "user" ou "system" (message de service : voir postSystemMessage).
    kind: m.kind === "system" ? "system" : "user",
    parentId: m.parentId ?? null,
    // Preview of the quoted message, when this is a reply. The client uses
    // it to render the inline quote without fetching the parent separately.
    parent: m.parent
      ? {
          id: m.parent.id,
          body: decryptBody(m.parent.body),
          author: m.parent.author ? publicUser(m.parent.author) : { id: m.parent.authorId },
        }
      : null,
    body: decryptBody(m.body),
    createdAt: m.createdAt,
    editedAt: m.editedAt ?? null,
    scheduledAt: m.scheduledAt,
    reactions: groupReactions(m.reactions),
    author: m.author ? publicUser(m.author) : { id: m.authorId },
    attachments: (m.attachments || []).map(serializeAttachment),
  };
}

export function serializeScheduled(m: MessageWithRelations) {
  return {
    id: m.id,
    channelId: m.channelId,
    body: decryptBody(m.body),
    createdAt: m.createdAt,
    scheduledAt: m.scheduledAt,
    attachments: (m.attachments || []).map(serializeAttachment),
  };
}

export async function ensureDefaultChannel() {
  let channel = await prisma.channel.findFirst({ where: { isDefault: true } });
  if (!channel) {
    channel = await prisma.channel.create({
      data: { name: "Général", isDefault: true, isPrivate: false, isDirect: false },
    });
  }
  const users = await prisma.user.findMany({ select: { id: true } });
  const members = await prisma.membership.findMany({
    where: { channelId: channel.id },
    select: { userId: true },
  });
  const have = new Set(members.map((m) => m.userId));
  const toAdd = users
    .filter((u) => !have.has(u.id))
    .map((u) => ({ userId: u.id, channelId: channel.id }));
  if (toAdd.length) {
    await prisma.membership.createMany({ data: toAdd, skipDuplicates: true });
  }
  return channel;
}

export default router;
