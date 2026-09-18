// Types de domaine côté client (phase 3).
//
// Ils décrivent ce que le SERVEUR sérialise réellement — les sources font foi :
//   - `User`    ← publicUser()        (server/src/routes/auth.ts)
//   - `Channel` ← serializeChannel()  (server/src/routes/channels.ts)
//   - `Message` / `Attachment` sont déjà inférés des schémas zod partagés, on
//     les ré-exporte plutôt que de les redéclarer : une seule source de vérité,
//     et impossible de diverger du contrôle runtime.
//
// Ce fichier n'existe qu'à la compilation : aucun code émis.
export type { Message, Attachment, MessagesResponse, NotificationEvent } from "../../shared/contracts.ts";

/** Utilisateur tel qu'exposé par l'API (publicUser). */
export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarColor: string;
  status: "active" | "disabled";
  isAdmin: boolean;
  isOwner: boolean;
  dndUntil: string | null;
  dndScheduleEnabled: boolean;
  dndStart: string | null;
  dndEnd: string | null;
}

/** Aperçu du dernier message d'une conversation (liste latérale). */
export interface LastMessagePreview {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
}

/** Niveau de notification choisi par le membre pour une conversation. */
export type NotifyLevel = "all" | "mentions" | "none";

/** Conversation (salon ou message direct), telle que sérialisée par le serveur. */
export interface Channel {
  id: string;
  name: string | null;
  /** Nom à afficher : pour un DM, la liste des autres participants. */
  displayName: string | null;
  isDirect: boolean;
  isPrivate: boolean;
  isDefault: boolean;
  /** "claude" = conversation privée avec un expert Claude (section CLAUDE). */
  kind?: "standard" | "claude";
  /** Clé de l'expert consulté (canaux kind="claude") : "supervision", "management"… */
  expert?: string | null;
  description: string | null;
  notifyLevel: NotifyLevel;
  members: User[];
  lastMessage: LastMessagePreview | null;
  unread: boolean;
}

/** Un expert Claude ouvert sur le serveur (GET /claude/experts, voir server/src/experts.ts). */
export interface ClaudeExpert {
  key: string;
  name: string;
  tagline: string;
  /** Libellé du bouton d'ouverture dans la barre latérale. */
  button: string;
}

/** Toast in-app affiché à la réception d'un message. */
export interface Toast {
  title: string;
  body: string;
  open: () => void;
}

/** Un message correspondant à une recherche par mot-clé (GET /search). */
export interface SearchResult {
  id: string;
  channelId: string;
  channel: Pick<Channel, "id" | "name" | "isDirect"> | null;
  author: Pick<User, "id" | "displayName" | "username" | "avatarColor"> | null;
  createdAt: string;
  editedAt: string | null;
  parentId: string | null;
  /** Extrait HTML avec les termes entourés de <mark> (voir routes/search.ts). */
  snippet: string;
  score: number;
}

/** Résultat du contrôle de version (GET /version) ou de l'updater desktop. */
export interface UpdateInfo {
  updateAvailable: boolean;
  latest?: string;
  downloadUrl?: string;
}
