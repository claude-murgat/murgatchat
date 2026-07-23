// Contrats de données aux frontières (phase 1 de la feuille de route typage).
//
// Schémas zod décrivant EXACTEMENT ce que le serveur sérialise, pour valider au
// runtime ce que le client reçoit (le côté « données non fiables »). Volontairement
// PUR : ce fichier n'importe que `zod` afin de pouvoir être déplacé tel quel dans un
// dossier `shared/` partagé client+serveur à l'étape suivante.
//
// Sources (server/src/routes/channels.js) :
//   - serializeMessage()    -> MessageSchema
//   - serializeAttachment() -> AttachmentSchema
//   - publicUser()          -> UserRefSchema (souple : parfois juste { id })
//   - GET /channels/:id/messages -> MessagesResponseSchema
//   - évènement socket "notification" (socket.js) -> NotificationEventSchema
//
// Choix de robustesse :
//   - `.passthrough()` : un champ ajouté côté serveur n'invalide pas (compat avant).
//   - `z.coerce.date()` : la même donnée est un Date côté serveur et une chaîne ISO
//     une fois passée sur le fil — la coercition accepte les deux.
import { z } from "zod";

const zId = z.string().min(1);
const zDate = z.coerce.date();

// Un utilisateur embarqué dans un message : en général le publicUser complet,
// parfois juste { id } (repli quand la relation n'a pas été chargée). On n'exige
// que ce dont le client se sert, le reste passe.
const UserRefSchema = z
  .object({
    id: zId,
    username: z.string().optional(),
    displayName: z.string().optional(),
    avatarColor: z.string().optional(),
  })
  .passthrough();

export const AttachmentSchema = z.object({
  id: zId,
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});

const ReactionGroupSchema = z.object({
  emoji: z.string(),
  count: z.number(),
  users: z.array(z.object({ id: zId, displayName: z.string().optional() })),
});

export const MessageSchema = z
  .object({
    id: zId,
    channelId: zId,
    parentId: zId.nullable(),
    parent: z
      .object({ id: zId, body: z.string(), author: UserRefSchema })
      .nullable(),
    body: z.string(),
    createdAt: zDate,
    editedAt: zDate.nullable(),
    scheduledAt: zDate.nullable(),
    reactions: z.array(ReactionGroupSchema),
    author: UserRefSchema,
    attachments: z.array(AttachmentSchema),
  })
  .passthrough();

// Réponse de GET /channels/:id/messages (firstUnreadId n'est renseigné qu'au
// chargement initial — null en pagination `before`).
export const MessagesResponseSchema = z
  .object({
    messages: z.array(MessageSchema),
    hasMore: z.boolean(),
    nextCursor: zId.nullable(),
    firstUnreadId: zId.nullable(),
  })
  .passthrough();

// Évènement socket "notification" : { channelId, message }.
export const NotificationEventSchema = z
  .object({
    channelId: zId,
    message: MessageSchema,
  })
  .passthrough();
