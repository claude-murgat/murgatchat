// Augmentation du type `Request` d'Express avec les propriétés que nos
// middlewares y attachent. Fichier de DÉCLARATIONS uniquement : rien n'est
// exécuté, rien n'est bundlé.
//
// `userId` et `user` sont posés par `requireAuth` (src/auth.ts), `io` est
// injecté dans src/index.ts pour que les routes puissent diffuser en temps réel.
//
// Choix assumé : `userId` et `io` sont déclarés NON optionnels. C'est faux au
// sens strict (une requête non authentifiée n'a pas de `userId`), mais toutes
// les routes qui les lisent passent par `requireAuth` / le middleware `io`. Les
// déclarer optionnels imposerait une cinquantaine de gardes `if (!req.userId)`
// qui n'apporteraient aucune sécurité réelle et masqueraient le vrai contrat.
import type { Server } from "socket.io";
import type { User } from "@prisma/client";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Identifiant de l'utilisateur authentifié — posé par `requireAuth`. */
      userId: string;
      /** Ligne utilisateur chargée par `requireAuth` (évite un re-fetch). */
      user?: User;
      /** Instance Socket.IO, injectée dans src/index.ts. */
      io: Server;
    }
  }
}

export {};
