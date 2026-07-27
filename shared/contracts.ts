// Contrats de données aux frontières (phases 1 et 3 de la feuille de route typage).
//
// PREMIER fichier converti en TypeScript (pilote de la phase 3). Il n'est PAS
// compilé : Node 24 retire les annotations de type à la volée, et Vite fait de
// même côté web. D'où l'extension `.ts` explicite dans les imports — Node ne
// résout pas `./contracts.js` vers `contracts.ts`.
//
// Schémas zod décrivant EXACTEMENT ce que le serveur sérialise, pour valider au
// runtime aux frontières (le client valide ce qu'il reçoit, le serveur ce qu'il
// émet). Volontairement PUR : n'importe que `zod`. Vit dans le mini-package
// autonome `shared/`, importé en relatif par web/ et server/ (pas de workspaces).
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

// Chaque forme est déclarée en DEUX temps :
//   - `…Base`  : l'objet strict — sert de source aux TYPES (z.infer), pour que
//                les fautes de frappe soient détectées à l'analyse ;
//   - exporté  : la version `.passthrough()` — sert à la VALIDATION runtime, qui
//                doit rester tolérante à un champ ajouté côté serveur.
// Sans cette séparation, `.passthrough()` ajoute une signature d'index au type
// inféré et `msg.bodyy` passerait silencieusement.

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

const MessageBase = z.object({
  id: zId,
  channelId: zId,
  parentId: zId.nullable(),
  parent: z.object({ id: zId, body: z.string(), author: UserRefSchema }).nullable(),
  body: z.string(),
  createdAt: zDate,
  editedAt: zDate.nullable(),
  scheduledAt: zDate.nullable(),
  reactions: z.array(ReactionGroupSchema),
  author: UserRefSchema,
  attachments: z.array(AttachmentSchema),
});
export const MessageSchema = MessageBase.passthrough();

// Réponse de GET /channels/:id/messages (firstUnreadId n'est renseigné qu'au
// chargement initial — null en pagination `before`).
// `…Base` porte le message STRICT (pour les types) ; la version exportée réinjecte
// le message tolérant (`.extend`) pour la validation runtime.
const MessagesResponseBase = z.object({
  messages: z.array(MessageBase),
  hasMore: z.boolean(),
  nextCursor: zId.nullable(),
  firstUnreadId: zId.nullable(),
});
export const MessagesResponseSchema = MessagesResponseBase.extend({
  messages: z.array(MessageSchema),
}).passthrough();

// Évènement socket "notification" : { channelId, message }.
const NotificationEventBase = z.object({
  channelId: zId,
  message: MessageBase,
});
export const NotificationEventSchema = NotificationEventBase.extend({
  message: MessageSchema,
}).passthrough();

// ── Types dérivés (phase 2) ───────────────────────────────────────────────
//
// Les types sont INFÉRÉS des schémas ci-dessus : une seule source de vérité, et
// impossible qu'ils divergent du contrôle runtime. À consommer depuis un fichier
// JS annoté, sans rien renommer en .ts :
//
//   /** @type {import("../../shared/contracts.js").Message} */
//
// (voir web/src/api.js pour un exemple câblé).

export type Attachment = z.infer<typeof AttachmentSchema>;
export type Message = z.infer<typeof MessageBase>;
export type MessagesResponse = z.infer<typeof MessagesResponseBase>;
export type NotificationEvent = z.infer<typeof NotificationEventBase>;
