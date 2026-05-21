# PROGRESS — journal de travail & mémoire long terme

Ce fichier récapitule ce qui a été construit sur **murgatchat** (clone Slack-like)
au fil des sessions, ainsi que les conventions et l'état du projet. Il sert de
**mémoire de référence** : à lire en priorité au début d'une session pour savoir
où on en est. La doc d'architecture détaillée reste dans le [README](README.md).

Dernière mise à jour : **2026-05-21**.

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

- **Pas de Node en local** → tout passe par **Docker** : `docker compose up -d --build`.
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

## Fonctionnalités en cours (branche `claude/feat/channel-membership`)

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

## Événements Socket.IO (catalogue)

- Client → serveur : `channel:join`, `channel:read`, `message:send`
  (`{channelId, body?, attachmentIds?, scheduledAt?, parentId?}`), `typing {channelId}`.
- Serveur → client : `message:new`, `message:updated`, `message:deleted`,
  `thread:reply`, `reaction:update`, `channel:created`, `channel:removed`,
  `notification`, `presence:state`, `presence:update`, `typing:update`.

## Décisions notables

- **Auteur uniquement** pour éditer/supprimer/répondre/réagir n'est pas restreint
  (réagir & répondre ouverts à tous ; éditer/supprimer = auteur). Pas de rôle admin.
- **Pas de threads imbriqués** (répondre à une réponse est refusé).
- **Réactions/présence/typing** ne touchent pas le mobile (Expo) : le backend les
  sert, mais l'UI React Native n'est pas faite.
- Présence & typing : état **en mémoire** (perdu au redémarrage serveur, OK pour ce stade).

## Limites connues / pistes

- **`web/package-lock.json` désynchronisé** : `emoji-picker-react` a été ajouté à
  `package.json` sans régénérer le lock (pas de Node local). Le build Docker
  (`npm install`) tolère ; lancer un `npm install` pour resynchroniser (sinon
  `npm ci` échouerait).
- Suppression d'un message avec PJ : lignes `Attachment` supprimées en cascade,
  mais **fichiers orphelins** sur disque.
- Sécurité (mise de côté pour l'instant) : `JWT_SECRET` à 30j sans refresh, CORS `*`,
  pas de HTTPS, `prisma db push` au démarrage. Voir le README pour le détail.
- Mobile : éditer/supprimer/threads/réactions/présence/typing à porter côté Expo.
