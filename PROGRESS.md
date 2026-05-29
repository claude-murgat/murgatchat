# PROGRESS — journal de travail & mémoire long terme

Ce fichier récapitule ce qui a été construit sur **murgatchat** (clone Slack-like)
au fil des sessions, ainsi que les conventions et l'état du projet. Il sert de
**mémoire de référence** : à lire en priorité au début d'une session pour savoir
où on en est. La doc d'architecture détaillée reste dans le [README](README.md).

Dernière mise à jour : **2026-05-29** (v0.5.1).

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
- **Adresse du serveur configurable au runtime** (écran de connexion, PR #12) :
  `VITE_API_URL` (web) et `app.json extra.API_URL` (mobile) ne sont plus que des
  **défauts de build**. IP LAN de la machine = **`172.16.2.191`** ; builder le web avec
  `VITE_API_URL=http://172.16.2.191:4000 docker compose up -d --build web` pour un défaut
  LAN-friendly. Le build mobile **public est livré sans serveur baké** (`extra.API_URL=""`).
- ⚠️ **Desktop Tauri (toolchain GNU) : `WebView2Loader.dll` doit être embarquée**
  (committée dans `web/src-tauri/`, référencée par `bundle.resources`) — sinon l'app ne
  démarre pas (« WebView2Loader.dll introuvable »). Le « portable » est un zip(exe+dll). PR #14.
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

## Itération 2026-05-26 — tests, serveur configurable, fixes & v0.2.1 (mergés)

17. **Suite de tests anti-régression (PR #11)** — backend **Vitest** (70 tests : HTTP via
    `supertest` + temps réel via `socket.io-client` + unitaires crypto / `isUserDnd` + gating
    push avec `fetch` Expo mocké) contre un **Postgres jetable** (Docker port 5434, ou
    `TEST_DATABASE_URL` en CI) ; **E2E Playwright** (parcours web complet, stack isolé
    `docker-compose.e2e.yml`) ; **test de charge k6** (`load/k6/chat-load.js`, 150 VUs :
    montée 1 min / plateau 8 min 30 / descente 30 s, 100 chatters WS + 50 readers HTTP) ;
    **CI GitHub Actions** (backend + e2e sur PR) ; doc **`TESTING.md`**. `server/src/index.js`
    exporte désormais `createServer()` / `startServer()` (bootable en mémoire pour les tests).
18. **Adresse du serveur configurable au runtime (PR #12)** — champ « Adresse du serveur » +
    bouton « Tester » (`GET /health`) sur l'écran de connexion (web/desktop **et** mobile),
    persisté `localStorage` (`chat_api_base`) / `AsyncStorage`, utilisé pour le REST **et** le
    Socket.IO. **Build mobile public sans serveur baké** (`extra.API_URL=""`) → un installeur
    Store aléatoire ne peut pas rejoindre le serveur sans en connaître l'adresse.
19. **Synchro « lu » multi-appareils (PR #13)** — le serveur rediffuse `channel:read` à la
    room `user:<id>` (hors émetteur) ; web + mobile effacent leur badge non-lu en le recevant.
20. **Fix desktop — `WebView2Loader.dll` (PR #14)** — le build Tauri GNU lie cette DLL en
    dynamique ; embarquée via `bundle.resources` (committée dans `web/src-tauri/`), sinon l'app
    ne démarrait pas. Portable = `dist/Chat-portable.zip` (exe + DLL).
21. **Fix « lu » seulement au premier plan (PR #15) + release 0.2.1** — `channel:read` n'est
    émis que si la fenêtre est focus + visible (`isWindowFocused`) côté web/desktop ; sinon une
    instance **masquée** mais avec une conversation sélectionnée effaçait le non-lu sur toutes
    les autres. Desktop + APK rebuildés en **0.2.1** (`dist/Chat_0.2.1_x64-setup.exe`).
22. **Fix mobile — parité read-focus (2026-05-26)** — `ChannelScreen` n'émet `channel:read`
    (ouverture + réception) que si `AppState === "active"`, + rattrapage au retour au premier
    plan : même logique que le web, adaptée au cycle de vie mobile.
23. **Inscription sur invitation, admin-only (2026-05-26)** — fini l'inscription ouverte :
    `POST /auth/register` exige un `token` d'invitation valide (e-mail correspondant, non
    utilisé, non expiré). **Exception bootstrap** : le tout premier compte (base vide) est créé
    sans invitation et devient **admin** (`User.isAdmin`). Seuls les admins invitent :
    `POST /auth/invitations` (crée + envoie l'e-mail via **nodemailer**),
    `GET /auth/invitations` (liste), `GET /auth/invitations/:token` (public : valide + pré-remplit
    l'e-mail). L'e-mail contient un **lien** (`APP_URL/?invite=<code>`) **et** un **code**.
    Clients web/desktop + mobile : écran d'inscription avec code (pré-rempli depuis `?invite=` sur
    le web), e-mail en lecture seule issu de l'invitation, + modale admin « Inviter un utilisateur ».
    **Mailpit** (mail-catcher) ajouté au compose dev (SMTP `mail:1025`, UI http://localhost:8025) et
    lancé en test (globalSetup) ; les tests vérifient que l'e-mail d'invitation est capturé avec le code.
    `Invitation` model (`email`, `token` unique, `invitedBy`, `expiresAt`, `acceptedAt`).

## Itération 2026-05-28 — SMTP configurable, mot de passe oublié, page profil

24. **SMTP entièrement configurable via `.env` (Brevo-ready)** — `server/src/mail.js`
    accepte désormais `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`
    (SSL direct, p. ex. 465) et `SMTP_REQUIRE_TLS` (impose STARTTLS, p. ex. 587 pour Brevo).
    `docker-compose.yml` propage ces variables avec défauts vers Mailpit pour le dev — on bascule
    sur **Brevo** (ou n'importe quel SMTP) simplement en renseignant le `.env`. Doc complète
    dans [.env.example](.env.example) (bloc Brevo prêt à décommenter + exemples SendGrid / OVH / Gmail).
25. **Mot de passe oublié (réinit par e-mail)** — nouveau modèle `PasswordReset` (token unique,
    TTL 1 h, `usedAt` pour empêcher la réutilisation). `POST /auth/forgot-password` répond toujours
    **200** (pas d'énumération de comptes) ; si le compte existe, l'ancien jeton en attente est
    invalidé et un nouveau est envoyé par e-mail (`sendPasswordResetEmail`). `GET /auth/password-reset/:token`
    valide publiquement le code et renvoie l'e-mail **masqué** (`al***@…`) à afficher. `POST /auth/reset-password`
    consomme le code, change le mot de passe et **auto-login** (renvoie un JWT). UI web + mobile : nouveau
    mode « Mot de passe oublié ? » → demande, puis écran « Définir le mot de passe » (rempli depuis
    `?reset=<code>` sur le web pour cliquer sur le lien de l'e-mail).
26. **Page « Mon profil »** — `PATCH /auth/me` permet de changer le nom affiché et/ou le mot de
    passe ; tout changement de mot de passe **exige le mot de passe actuel** (defense-in-depth contre
    une session volée). UI : nouvelle entrée « Mon profil » dans le menu de la sidebar (web/desktop)
    et du menu trois points (mobile) → modale avec deux blocs (nom affiché / mot de passe). Mises
    à jour reflétées dans tout l'UI via `setUser`.
27. **Desktop + APK 0.3.0 (alpha-testing)** — `dist/Chat_0.3.x_x64-setup.exe` (NSIS) +
    `dist/Chat-portable.zip` (exe + WebView2Loader.dll) **et** `dist/Chat_0.3.x.apk` (~65 Mo)
    rebuildés avec toutes les features ci-dessus. Versions harmonisées partout
    (`tauri.conf.json`, `web/src-tauri/Cargo.toml`, `web/package.json`, `mobile/app.json`
    versionCode, `mobile/package.json`). Smoke-tests OK : desktop window handle non-zero +
    12 procs msedgewebview2 ; APK installé sur émulateur `alarm_dev` Android 11, lancement
    + PID vivant, `dumpsys` confirme versionName/versionCode. **Règle persistée
    en mémoire** : un rebuild APK ou desktop ⇒ on rebuild **les deux** pour garder l'alpha
    aligné, sauf demande explicite "uniquement ...".
29. **Propriétaire + panel d'administration (0.4.0)** — Nouveau rôle `User.isOwner`
    (un seul à la fois). Hiérarchie **owner > admin > membre** :
    - Owner : peut promouvoir/révoquer les admins, désactiver les admins, transférer la
      propriété (l'ancien owner reste admin). N'est jamais désactivable/révocable
      (`owner_protected`).
    - Admin : peut inviter, désactiver les membres simples (pas les autres admins).
    - Suppression d'utilisateur = **soft delete** (`User.status='disabled'`). Login refusé
      avec le même `invalid_credentials` (anti-énum) et `requireAuth` re-vérifie le status
      à chaque requête, donc les JWT actifs sont invalidés instantanément.

    Endpoints : `GET /auth/users` (admin), `PATCH /auth/users/:id` (`{isAdmin?, status?}`,
    permissions au niveau du champ), `POST /auth/transfer-ownership`. **`ensureOwner()`
    au démarrage** auto-promeut le plus ancien admin si la base n'a pas d'owner (migration
    silencieuse pour les déploiements pré-0.4.0).

    UI : modale **AdminPanelModal** (web/desktop) + **AdminPanelScreen** (mobile, stack
    navigation) — recherche par nom/username/email, badges rôle (Propriétaire/Admin/Membre)
    et status, actions contextuelles, confirmation modale pour désactivation et transfert.
    Entrée « Administration » dans le menu utilisateur, gated `isAdmin`.

    Tests : 12 nouveaux dans `test/http/admin-panel.test.js`. Suite à **106/106 verts**.

28. **UX bootstrap premier compte (0.3.1)** — `GET /health` expose `needsBootstrap`
    (`User.count() === 0`). L'écran de login (web + mobile) **probe `/health` dès qu'une
    adresse de serveur est saisie** (debounced) et, si la base est vide, affiche un encart
    « Premier démarrage 🎉 — créez le compte admin » à la place du lien trompeur « J'ai une
    invitation ». Dans le mode register, le champ « Code d'invitation » est masqué et le
    bouton devient « Créer le compte admin ». Plus besoin de connaître l'astuce du code
    d'invitation vide pour installer un nouveau serveur. Tests : 3 nouveaux tests
    `test/http/health.test.js` (suite à 94/94). APK et desktop rebuildés en 0.3.1.

## Itération 2026-05-29 — robustesse, recherche, réponses inline, notes perso (v0.5.0)

29. **Cleanup des fichiers orphelins (#26)** — suppression synchrone des blobs sur disque
    quand un message à PJ est supprimé (route message + scheduled), **+ sweep périodique**
    (`server/src/sweep.js`, toutes les heures, 1ʳᵉ passe à T+5 min) : blobs sans `Attachment`
    row > 1 h, et rows `messageId=null` > 24 h. Helpers `server/src/storage.js`.
30. **Pagination + recherche du panel admin (#27)** — `GET /auth/users?page=&pageSize=&q=`
    (pageSize clampé ≤ 100, `q` OR insensible sur displayName/username/email). Web « Voir plus »,
    mobile infinite-scroll, anti-stale-response.
31. **Chiffrement at-rest des fichiers (#28)** — uploads chiffrés AES-256-GCM
    (`[version][IV][ciphertext][tag]`, même clé que les bodies). `Attachment.encrypted` ;
    les blobs pré-existants restent servis en clair (rétro-compat). multer en mémoire.
32. **Recherche full-text Postgres (#29)** — `Message.searchableBody` (plaintext, mirroir du
    body chiffré) + index GIN `to_tsvector('french', …)` créé au démarrage (`ensureSearchIndex`).
    `GET /search?q=&channelId?=&limit?=` scopé aux memberships, snippet `<mark>` via `ts_headline`,
    ranking `ts_rank`. UI : modale web (Cmd/Ctrl+K + 🔍 sidebar), écran mobile (🔍 header).
    ⚠ Compromis acté : exclut un futur E2E sur les mêmes canaux.
33. **Réponses inline « Discord/Messenger » (#31)** — abandon du panneau Thread Slack. Les
    réponses vivent désormais **dans la timeline** avec une bulle de citation (auteur + extrait)
    cliquable au-dessus du message. `serializeMessage` embarque `parent {id, author, body}` ;
    `GET /channels/:id/messages` ne filtre plus `parentId=null` ; `message:send` émet toujours
    `message:new` (plus de `thread:reply`) ; endpoint `/thread` supprimé. Bandeau « ↩ Réponse à »
    au-dessus du composer (web + mobile).
34. **Auto-DM « notes pour soi » (#32)** — un DM avec soi-même (canal à 1 membre) sert de
    bloc-notes permanent. `POST /channels/dm` accepte `userIds:[self]`/`[]`. UI : « 📝 Mes notes »
    dans NewDm + icône dédiée dans la sidebar. Checkboxes **mutuellement exclusives** : soi-même
    OU les autres, jamais les deux.

Tests backend à **128/128 verts**. Desktop + APK rebuildés en **0.5.0** (versionCode 6).

## Itération 2026-05-29 (bis) — Markdown + retrait des serveurs bakés (v0.5.1)

35. **Rendu Markdown (GFM) des messages** — les bodies sont saisis en texte brut et
    **interprétés en Markdown à l'affichage** (gras/italique, code inline + blocs avec
    coloration syntaxique, listes, liens, citations, tables, barré, task-lists). Web/desktop :
    `react-markdown` + `remark-gfm` + `rehype-highlight` (`web/src/components/MessageMarkdown.jsx`,
    thème highlight.js scoped `.md-body` dans `styles.css`). Mobile : `react-native-markdown-display`
    (`mobile/src/components/MessageMarkdown.js`, blocs de code monospace sans coloration par
    langage). **Aucun HTML brut rendu → pas de XSS** ; liens ouverts en nouvel onglet / navigateur
    système. Le rendu ne s'applique qu'à la timeline ; les aperçus (citation de réponse, sidebar,
    notifications, recherche) restent en texte brut. Pas de changement serveur (le `body` stocké
    EST la source Markdown ; la recherche full-text marche sur cette source).
36. **Retrait des serveurs bakés dans les builds (desktop + APK)** — `web/src/api.js` :
    le défaut `localhost:4000` ne s'applique plus qu'en **dev** (`import.meta.env.DEV`) ;
    un build de prod **sans** `VITE_API_URL` part avec un serveur **vide**, forçant la saisie
    de l'adresse sur l'écran de connexion. L'installeur desktop 0.5.1 est désormais buildé **sans**
    `VITE_API_URL` (plus d'IP LAN `172.16.2.191` bakée). L'APK était déjà sans serveur baké
    (`extra.API_URL=""`) — inchangé, confirmé. Le web servi par Docker garde son `VITE_API_URL`
    baké (LAN), inchangé.

E2E web étendu (assertions Markdown `<strong>`/`<code>`, survit au reload). Desktop + APK
rebuildés en **0.5.1** (versionCode 7).

## Événements Socket.IO (catalogue)

- Client → serveur : `channel:join`, `channel:read`, `message:send`
  (`{channelId, body?, attachmentIds?, scheduledAt?, parentId?}`), `typing {channelId}`,
  `activity` (heartbeat web/desktop). Handshake : `auth.platform` (`web`/`desktop`/`mobile`).
- Serveur → client : `message:new` (les réponses incluses, avec `parent` pour la
  citation inline — plus de `thread:reply` depuis v0.5.0), `message:updated`,
  `message:deleted`, `reaction:update`, `channel:created`, `channel:removed`,
  `channel:members`, `notification`, `presence:state`, `presence:update`,
  `typing:update`, **`channel:read`** (rediffusé aux autres appareils du même
  utilisateur pour synchroniser les non-lus).

## Décisions notables

- **Auteur uniquement** pour éditer/supprimer/répondre/réagir n'est pas restreint
  (réagir & répondre ouverts à tous ; éditer/supprimer = auteur). Rôle **admin minimal**
  introduit (`User.isAdmin`, 1er compte bootstrap) uniquement pour gérer les invitations.
- **Pas de threads imbriqués** (répondre à une réponse est refusé).
- **Mobile (Expo)** désormais à parité complète avec le web (réactions, présence,
  typing, threads, gestion des membres, DM de groupe, planning DND, push).
- Présence & typing : état **en mémoire** (perdu au redémarrage serveur, OK pour ce stade).

## Limites connues / pistes

- Suppression d'un message avec PJ : lignes `Attachment` supprimées en cascade,
  mais **fichiers orphelins** sur disque.
- Sécurité (mise de côté pour l'instant) : `JWT_SECRET` à 30j sans refresh, CORS `*`,
  pas de HTTPS, `prisma db push` au démarrage. **Inscription sur invitation** + **mot de passe
  oublié** + **profil** désormais en place ; **SMTP entièrement configurable** (Brevo, etc.).
  Reste : HTTPS. **iOS** : `app.json` `ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads=true`
  (autorise le HTTP en clair, nécessaire pour le serveur dev/LAN configurable) — à durcir
  (HTTPS) avant une publication App Store. Voir le README pour le détail.
- **Mobile** : envoi de **pièces jointes** non porté (l'affichage marche ; l'upload
  demande un picker natif). Build Android à faire hors d'un chemin avec espace ; l'APK
  release est signée avec la **clé debug** (à remplacer par une vraie clé pour distribuer).
- **Notifications push** (livrées — voir plus haut) : reste à câbler côté infra un
  **projectId Expo + FCM** (`google-services.json` + `android.googleServicesFile`) pour
  la livraison réelle sur device, et `usesCleartextTraffic` (ou HTTPS) pour joindre l'API.
