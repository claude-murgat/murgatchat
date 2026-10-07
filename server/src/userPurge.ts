import type { Server } from "socket.io";
import { prisma } from "./db.ts";
import { safeUnlink } from "./storage.ts";
import { revokeUserSessions } from "./socket.ts";
import { broadcastMembers } from "./routes/channels.ts";

// Suppression DÉFINITIVE d'un compte (panneau d'admin, DELETE /auth/users/:id).
// La base fait l'essentiel par cascade : memberships, messages (avec leurs pièces
// jointes et réactions), réactions, jetons push, réinitialisations de mot de
// passe. Ce module traite ce que la cascade ferait MAL :
//   - les réponses des AUTRES à ses messages : la cascade `parentId` les
//     emporterait — elles sont détachées (perdent la citation, pas leur contenu) ;
//   - ses conversations à deux (DM, conversation avec un expert Claude) : réduit
//     au survivant, un DM s'afficherait chez lui comme « Mes notes » (voir
//     serializeChannel) en doublon de ses vraies notes — supprimées en entier ;
//   - ses invitations (cascade `invitedBy`) : rattachées à l'admin qui supprime,
//     pour que les liens déjà envoyés par e-mail restent valides ;
//   - les fichiers chiffrés sur disque : la cascade n'efface que les lignes.
// Rapports de bug et conversations de support survivent (SetNull, par
// conception : le backlog admin ne fond pas avec les départs).
export async function purgeUser(io: Server, userId: string, heirId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { channel: { include: { memberships: { select: { userId: true } } } } },
  });
  // Un DM de groupe garde ses survivants (au moins deux) : il reste une vraie
  // conversation entre eux.
  const doomed = memberships
    .map((m) => m.channel)
    .filter((c) => (c.isDirect || c.kind === "claude") && c.memberships.length <= 2);
  const doomedIds = doomed.map((c) => c.id);
  const keptIds = memberships
    .map((m) => m.channelId)
    .filter((id) => !doomedIds.includes(id));

  // Lus AVANT la suppression : une fois les lignes parties, plus moyen de
  // retrouver les blobs. Ses envois jamais rattachés (ni message, ni rapport)
  // sont effacés aussi ; ceux d'un rapport de bug restent avec le rapport.
  const attachments = await prisma.attachment.findMany({
    where: {
      OR: [
        { message: { authorId: userId } },
        { message: { channelId: { in: doomedIds } } },
        { uploadedBy: userId, messageId: null, bugReportId: null, supportConversationId: null },
      ],
    },
    select: { id: true, messageId: true, storagePath: true },
  });

  await prisma.$transaction([
    prisma.message.updateMany({
      where: { parent: { authorId: userId }, authorId: { not: userId } },
      data: { parentId: null },
    }),
    prisma.invitation.updateMany({ where: { invitedBy: userId }, data: { invitedBy: heirId } }),
    // Les autres pièces jointes partent en cascade avec leur message.
    prisma.attachment.deleteMany({
      where: { id: { in: attachments.filter((a) => !a.messageId).map((a) => a.id) } },
    }),
    prisma.channel.deleteMany({ where: { id: { in: doomedIds } } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
  // Au mieux : le balayage horaire (sweep.ts) rattrape un blob qui résisterait.
  await Promise.all(attachments.map((a) => safeUnlink(a.storagePath)));

  // Le compte est désactivé avant d'être supprimé, ses sessions sont donc déjà
  // fermées — sauf course avec une reconnexion : on coupe quand même.
  revokeUserSessions(io, userId, "deleted");
  for (const c of doomed) {
    for (const m of c.memberships) {
      if (m.userId === userId) continue;
      io.to(`user:${m.userId}`).emit("channel:removed", { channelId: c.id });
      io.in(`user:${m.userId}`).socketsLeave(`channel:${c.id}`);
    }
  }
  await Promise.all(keptIds.map((id) => broadcastMembers(io, id)));
  // Ses messages ont disparu de tous les salons, y compris ceux que le compte
  // avait quittés : chaque client retire du fil ouvert ce qui en venait.
  io.emit("user:deleted", { userId });
}
