# PROGRESS — journal de travail & mémoire long terme

Ce fichier récapitule ce qui a été construit sur **murgatchat** (clone Slack-like)
au fil des sessions, ainsi que les conventions et l'état du projet. Il sert de
**mémoire de référence** : à lire en priorité au début d'une session pour savoir
où on en est. La doc d'architecture détaillée reste dans le [README](README.md).

Dernière mise à jour : **2026-05-22**.

---

## Conventions de collaboration

- **Branches** : `claude/[feat|fix]/[nom]` (ex. `claude/feat/threads`,
  `claude/fix/upload-encoding`). `feat` = nouvelle fonctionnalité, `fix` = correctif.
- **Commits** : identité passée en ligne de commande à chaque commit, jamais via
  la config git :
  `git -c user.name="Charles" -c user.email="charles@murgat-chat.local" commit ...`
- **Flux** : une branche par lot de travail → 1 commit par préoccupation (feat/fix/docs)
  → PR vers `main` → merge (merge commit) → suppression de la branche distante **et**
  des branches locales, puis retour sur `main`.
- **Remote** : `origin` = https://github.com/claude-murgat/murgatchat
- Les branches `claude/*` **suivent `origin/main`** : toujours pousser
  explicitement sur la branche de feature (`git push -u origin <branche>`),
  jamais un `git push` nu (qui viserait `main`).

## Lancer le projet (cette machine)

- **Toolchains installées (2026-05-22)** : Node 20, Rust 1.95 (GNU) + mingw-w64
  (build Tauri), JDK 17 + Android SDK + émulateur `alarm_dev` (build/test APK). Le
  stack serveur/web reste lancé via **Docker** : `docker compose up -d --build`.
- ⚠️ **Piège « chemin avec espace »** : le projet est sous `…\Projets Claude\…`. Les
  builds natifs cassent sur l'espace (`dlltool`/`as` pour Tauri ; `ninja` pour Android).
  Builder hors d'un chemin avec espace : Tauri via `CARGO_TARGET_DIR=C:\murgat-build` ;
  APK en copiant `mobile/` vers `C:\murgat-mobile`.
- Le bundle web **fige `VITE_API_URL` à la build**. IP LAN de la machine =
  **`172.16.2.191`**. Builder le web avec
  `VITE_API_URL=http://172.16.2.191:4000 docker compose up -d --build web`
  pour que ça marche depuis le LAN (un `localhost` ne marche que sur cette machine).
- **Secrets dans un `.env` gitignoré** (interpolé par docker-compose) ; modèle
  versionné dans [.env.example](.env.example). Sur un nouveau checkout :
  `cp .env.example .env` puis remplir.
- **Clé de chiffrement** (`MESSAGE_ENCRYPTION_KEY`) : volontairement la valeur de
  test publique `0123…def` pour garder lisibles les messages de test déjà chiffrés.
  **À régénérer (`openssl rand -hex 32`) et figer avant toute vraie donnée.**
- **Comptes de test** : `alice` / `bob`, mot de passe `test1234` (login par email
  ou username). Persistés dans le volume `db-data`.
- Ports : web http://localhost:5173, API http://localhost:4000 (`/health`),
  Postgres host `5433`.

## Fonctionnalités livrées (mergées dans `main`)

1. **Secrets externalisés** — creds Postgres / `JWT_SECRET` /
   `MESSAGE_ENCRYPTION_KEY` sortis de `docker-compose.yml` vers `.env` + `.env.example`.
2. **Édition de messages** (auteur uniquement) — `PATCH /channels/messages/:id`,
   champ `Message.editedAt`, temps réel `message:updated`, UI inline + indicateur
   « (modifié) ».
3. **Suppression de messages** (auteur uniquement) — `DELETE /channels/messages/:id`,
   temps réel `message:deleted` (porte `parentId`), confirmation.
4. **Threads** — `Message.parentId` (auto-relation, cascade) ; `message:send`
   accepte `parentId` et émet `thread:reply` ; `GET /channels/messages/:id/thread` ;
   le canal ne liste que les racines + `replyCount`. UI : panneau latéral droit,
   action « Répondre », pied « N réponses ».

## Fonctionnalités livrées — suite (mergées)

5. **Réactions emoji** — modèle `Reaction` (unique `[messageId,userId,emoji]`,
   cascade) ; `POST /channels/messages/:id/reactions` en toggle ; `serializeMessage`
   expose `reactions: [{emoji, count, users:[{id,displayName}]}]` ; temps réel
   `reaction:update`. UI : sélecteur **emoji-picker-react** (bouton 😀, fermeture
   au clic extérieur), chips cliquables, **tooltip stylé au survol** listant qui a
   réagi (« X a réagi » / « X et Y ont réagi » / « X, Y et N autres ont réagi »).
6. **Présence en ligne** — suivi en mémoire des sockets par utilisateur ;
   `presence:state` (à la connexion) + `presence:update` (transitions 0↔1 socket).
   UI : pastille verte/grise sur les DM + statut dans l'en-tête.
7. **Indicateurs de saisie (typing)** — `typing {channelId}` relayé en
   `typing:update {channelId,userId}` aux autres du salon. UI : « X est en train
   d'écrire… » au-dessus du composer (throttle ~2s, expiration ~4s), et **avatar
   remplacé par « … »** dans la liste des DM quand l'autre tape.

## Fonctionnalités livrées — gestion des membres (mergées)

8. **Salon par défaut « Général »** — `Channel.isDefault` (unique). Créé au
   démarrage (`ensureDefaultChannel` dans index.js) ; tous les utilisateurs
   existants y sont ajoutés, et chaque nouvel inscrit aussi (route register).
9. **Rejoindre / parcourir les salons publics** — `GET /channels/public?q=`
   (publics non rejoints) + `POST /channels/:id/join`. UI : modale « Parcourir
   les salons » via le 🔍 de la section Salons.
10. **Gérer les membres** — ajouter (`POST /channels/:id/members`), voir/retirer
    (modale au clic sur « X membres » ; `DELETE /channels/:id/members/:userId`) et
    **quitter** un salon (`POST /channels/:id/leave`). Retirer/quitter sont
    interdits pour le salon par défaut. Émet `channel:removed` (+ socketsLeave) à
    l'utilisateur concerné. UI : bouton « + Membres » + « X membres » cliquable.
11. **UX modales** — toutes les modales se ferment au clic en dehors.

## Fonctionnalités livrées — extras messagerie (mergées)

12. **Emojis dans les messages** — bouton 😀 dans le composer (emoji-picker-react) ;
    l'emoji s'insère dans le texte. Ferme au clic extérieur.
13. **Indicateur de messages non lus** — `serializeChannel` expose `unread`
    (dernier message après le `lastReadAt` du membre, hors soi) ; suivi client en
    temps réel (message:new sur canal non actif → non lu, effacé à la sélection) ;
    sidebar en gras + pastille.
14. **DM de groupe** — `POST /channels/dm` accepte `userIds[]` : 2+ → conversation
    directe à 3+ membres, réutilisée si l'ensemble existe déjà ; affichée par les
    noms des participants joints (icône groupe, présence en 1-1 seulement).
15. **Planning DND** — `User.dndScheduleEnabled/dndStart/dndEnd` (HH:MM) +
    `POST /auth/dnd-schedule` ; `isUserDnd` gate les notifs (fenêtre ponctuelle OU
    plage quotidienne avec passage de minuit). ⚠ La plage utilise l'**heure du
    serveur** (pas le fuseau du client) — à affiner si besoin.

## Correctifs (mergés)

16. **Diffusion des membres à l'inscription** — `broadcastMembers` est désormais
    appelé après l'auto-ajout au salon par défaut dans `POST /auth/register` (était
    oublié ; les membres connectés voyaient un décompte de membres obsolète).

## Clients Web / Desktop / Mobile (mergés 2026-05-22)

- **Mobile (Expo) à parité complète avec le web** — refonte React Native autour d'un
  `ChatContext` (état + Socket.IO temps réel). Liste avec sections / non-lus / présence /
  typing / badges de groupe ; salon avec réactions / édition / suppression / threads /
  typing / planifiés ; gestion des membres, parcourir-rejoindre, DM de groupe, planning
  DND, EmojiPicker maison (sans dépendance native). `api.js` couvre tous les endpoints ;
  URL surchargée par `EXPO_PUBLIC_API_URL`. **Support Expo Web** ajouté
  (`react-native-web`) → l'app se lance et se teste dans un navigateur.
- **Desktop (Tauri) rebuildé en 0.2.0** — n'embarque que le bundle web (hérite de toutes
  les features). `dist/Chat_0.2.0_x64-setup.exe` reconstruit avec
  `VITE_API_URL=http://172.16.2.191:4000` (l'ancien défaut `.192` était faux). Build natif
  GNU + mingw-w64 (recette dans le README).
- **APK Android testée** — release APK standalone (Gradle, ABI x86_64), installée et
  lancée sur l'émulateur `alarm_dev` (Android 11), **login OK contre l'API Docker**
  (`10.0.2.2:4000`). ⚠ Le release bloque le HTTP en clair : `usesCleartextTraffic` requis
  pour un backend HTTP/LAN (ou HTTPS en prod).
- **Notifications push « si loin de l'ordi »** — sur mobile, push système uniquement
  quand l'app n'est pas active / le téléphone verrouillé, **et** que le web+desktop sont
  inactifs depuis ≥ 10 min, **et** que le compte n'est pas en DND. Serveur : modèle
  `PushToken`, `POST/DELETE /auth/push-token`, suivi `lastWebActivity` (sockets taggés par
  plateforme au handshake), `notifyMembers` → push Expo + purge des tokens invalides.
  Web/desktop : heartbeat `activity`. Mobile : `expo-notifications`. Gating vérifié côté
  serveur ; **livraison réelle = projectId Expo + FCM (`google-services.json`) à câbler**.

## Événements Socket.IO (catalogue)

- Client → serveur : `channel:join`, `channel:read`, `message:send`
  (`{channelId, body?, attachmentIds?, scheduledAt?, parentId?}`), `typing {channelId}`,
  `activity` (heartbeat web/desktop). Handshake : `auth.platform` (`web`/`desktop`/`mobile`).
- Serveur → client : `message:new`, `message:updated`, `message:deleted`,
  `thread:reply`, `reaction:update`, `channel:created`, `channel:removed`,
  `channel:members`, `notification`, `presence:state`, `presence:update`,
  `typing:update`.

## Décisions notables

- **Auteur uniquement** pour éditer/supprimer/répondre/réagir n'est pas restreint
  (réagir & répondre ouverts à tous ; éditer/supprimer = auteur). Pas de rôle admin.
- **Pas de threads imbriqués** (répondre à une réponse est refusé).
- **Mobile (Expo)** désormais à parité complète avec le web (réactions, présence,
  typing, threads, gestion des membres, DM de groupe, planning DND, push).
- Présence & typing : état **en mémoire** (perdu au redémarrage serveur, OK pour ce stade).

## Limites connues / pistes

- Suppression d'un message avec PJ : lignes `Attachment` supprimées en cascade,
  mais **fichiers orphelins** sur disque.
- Sécurité (mise de côté pour l'instant) : `JWT_SECRET` à 30j sans refresh, CORS `*`,
  pas de HTTPS, `prisma db push` au démarrage. Voir le README pour le détail.
- **Mobile** : envoi de **pièces jointes** non porté (l'affichage marche ; l'upload
  demande un picker natif). Build Android à faire hors d'un chemin avec espace ; l'APK
  release est signée avec la **clé debug** (à remplacer par une vraie clé pour distribuer).
- **Notifications push** (livrées — voir plus haut) : reste à câbler côté infra un
  **projectId Expo + FCM** (`google-services.json` + `android.googleServicesFile`) pour
  la livraison réelle sur device, et `usesCleartextTraffic` (ou HTTPS) pour joindre l'API.
