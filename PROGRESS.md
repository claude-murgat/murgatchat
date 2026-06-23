# PROGRESS — journal de travail & mémoire long terme

Ce fichier récapitule ce qui a été construit sur **murgatchat** (clone Slack-like)
au fil des sessions, ainsi que les conventions et l'état du projet. Il sert de
**mémoire de référence** : à lire en priorité au début d'une session pour savoir
où on en est. La doc d'architecture détaillée reste dans le [README](README.md).

Dernière mise à jour : **2026-06-23** (auto-updater desktop signé + installation tous-utilisateurs/TSE, recherche unifiée dans la sidebar, fix notifs PWA/desktop, réouverture sur la dernière conversation).

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

39. **Version checker in-app (bannière de MAJ)** — le serveur expose `GET /version`
    `{version, downloadUrl}` (piloté par les env `CLIENT_VERSION` / `DOWNLOAD_URL` ; défaut =
    version du `server/package.json`, basse → checker inactif tant que non configuré). Chaque
    client embarque sa version au build (web/desktop via `__APP_VERSION__` injecté par Vite ;
    mobile via `Constants.expoConfig.version`) et la compare à celle du serveur **au démarrage,
    au focus, et toutes les 15 min**. Si une version plus récente est annoncée, une bannière
    apparaît : **web → « Rafraîchir »** (`location.reload`), **desktop (Tauri) → « Télécharger »**
    (ouvre `downloadUrl` = page Releases), **Android → bannière d'info seule** (sans action, par
    décision produit). Comparaison semver maison (`version.js`, suffixe `-rc` ignoré), bannière
    masquable par version. Pour tester : déployer le serveur avec `CLIENT_VERSION=<version publiée>`
    > version du client ouvert. Tests : +2 `test/http/version.test.js` (suite à 132/132).

38. **Pipeline de release automatisé (CI sur tag `v*`)** — nouveau
    [`.github/workflows/release.yml`](.github/workflows/release.yml) : push d'un tag `v*` →
    `test` (réutilise `tests.yml` via `workflow_call`) → `release` (release **draft** + validation
    que les 5 fichiers de version == tag) → `desktop` (`windows-latest`, **MSVC** via
    `tauri-apps/tauri-action`, sans `VITE_API_URL`) **et** `android` (`ubuntu-latest`, `expo prebuild`
    + APK **signée upload-keystore**) en parallèle → `publish` (draft → live). Les deux binaires sont
    attachés à la Release ; **on ne committe plus `dist/`** (gitignoré). Signature Android via le
    config-plugin [`mobile/plugins/withReleaseSigning.js`](mobile/plugins/withReleaseSigning.js)
    (`signingConfig release` gardé par `hasProperty`, fallback debug en local) + `app.config.js`
    (injecte versionName/versionCode depuis le tag) + `usesCleartextTraffic` via `expo-build-properties`.
    versionCode dérivé du semver (monotone). 4 secrets GitHub à créer (keystore base64 + mots de passe +
    alias). Cleanup : `WebView2Loader.dll` + `bundle.resources` retirés (MSVC lie en statique),
    `Cargo.lock` désormais committé. **Les builds locaux GNU sont dépréciés** au profit de la CI.
    Dry-run config-plugin validé en local (signingConfig release injecté, cleartext OK).

37. **Fix : serveur `10.0.2.2:4000` baké dans l'APK (v0.5.2)** — bug remonté par l'alpha :
    une APK fraîchement installée affichait `http://10.0.2.2:4000` pré-rempli dans le champ
    serveur, malgré `app.json extra.API_URL=""`. **Cause racine** : le défaut runtime mobile vient
    de `Constants.expoConfig.extra.API_URL`, lu depuis `android/.../assets/app.config` **figé au
    build** — pas de `app.json` directement ni du bundle JS. Le sync robocopy **exclut `android/`**
    et la tâche Gradle `createExpoConfig` restait `UP-TO-DATE`, donc cet `app.config` datait d'un
    prebuild **antérieur à PR #12** (quand `extra.API_URL` valait encore `10.0.2.2`). Invisible sur
    l'émulateur (où `10.0.2.2` fonctionne), visible sur un vrai téléphone. **Fix** : `gradlew clean`
    avant `assembleRelease` pour régénérer `app.config` depuis l'`app.json` courant ; vérification
    par `unzip -p app-release.apk assets/app.config | grep API_URL` → `""`. Desktop + APK rebuildés
    en **0.5.2** (versionCode 8, règle pair). Le desktop n'était pas affecté (jamais de `10.0.2.2`,
    et `172.16.2.191` déjà retiré en 0.5.1).

## Événements Socket.IO (catalogue)

- Client → serveur : `channel:join`, `channel:read`, `message:send`
  (`{channelId, body?, attachmentIds?, scheduledAt?, parentId?}`), `typing {channelId}`,
  `activity` (heartbeat web/desktop ~60s) + `away` (fenêtre masquée / onglet en arrière-plan →
  relance le push ; sur desktop Tauri, piloté par l'état natif réel de la fenêtre, cf #78).
  Handshake : `auth.platform` (`web`/`desktop`/`mobile`).
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
- **Réponses inline à plat** (modèle Discord/Messenger depuis #31) : on peut répondre à
  **n'importe quel** message livré du salon, **y compris une autre réponse**. La citation
  reste sur **un seul niveau** (on n'affiche que le message cité, jamais sa propre citation),
  donc pas d'imbrication. _(Avant le fix v0.5.2-bis, répondre à une réponse était refusé avec
  `invalid_parent` — reliquat du modèle Slack-threads.)_
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

## Itération 2026-06-10 — Pivot PWA + responsive web

**Pivot stratégique iOS** (cf [`memory/project_pwa-pivot.md`](.) et conversation du 2026-06-10) :
abandon des builds natifs iOS (Xcode 26 exigé par Apple = arm64-only = incompatible
avec la Mac VM x86_64). **Les utilisateurs iPhone passent par la PWA installée via
Safari → "Ajouter à l'écran d'accueil"** plutôt que par TestFlight.

40. **PWA core + iOS support (#46)** — Le client web est désormais une PWA installable :
    `vite-plugin-pwa` en mode `injectManifest`, manifest web auto-généré au build
    (`name`, `short_name`, `start_url`, `display: standalone`, `theme_color: #3F0E40`).
    Icônes PNG générées sans dépendance externe par `web/scripts/generate-icons.cjs`
    (encodeur PNG zlib + CRC32) : `icon-192`, `icon-512`, `icon-512-maskable`, `badge-72`.
    `index.html` reçoit les meta iOS standalone (`apple-mobile-web-app-capable`,
    status bar `black-translucent`, `apple-touch-icon`, `theme-color`, viewport
    `viewport-fit=cover` pour le notch). Service worker dans `web/src/sw.js` :
    handler `push` défensif (parsing JSON → text → fallback, `showNotification`
    inconditionnel — silence-push = SW révoqué sur iOS), handler `notificationclick`
    qui focus une fenêtre existante OU `openWindow` avec workaround Cache Storage
    pour le bug WebKit "kill-app perd targetUrl" (le SW stocke l'URL cible dans
    une Cache Storage, le client la consomme au prochain boot via `pwa.js`).
    `web/src/pwa.js` orchestre côté client : registration SW, subscription push
    (resubscribe robuste au focus, gère `pushsubscriptionchange`), dispatch des
    messages SW vers la fenêtre. Sidebar expose "🔔 Activer les notifications"
    (idempotent) et "📱 Installer l'application" (déclenche `beforeinstallprompt`
    sur Chrome/Edge ; iOS Safari n'a pas d'événement, l'utilisateur fait Partager
    → Ajouter à l'écran d'accueil manuellement).

41. **Web Push backend (VAPID + endpoints) (#46)** — Nouveau modèle Prisma
    `WebPushSubscription` (endpoint unique par navigateur, `p256dh`, `auth`, `userAgent`
    optionnel). `server/src/webpush.js` charge ou génère les clés VAPID au démarrage,
    persistées dans `/data/meta/vapid.json` (volume Docker `server-meta`), surchargeables
    par les env `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`. Trois nouveaux
    endpoints : `GET /auth/web-push/vapid-public-key` (public, le SW en a besoin pour
    `pushManager.subscribe`), `POST /auth/web-push/subscribe` (upsert par endpoint, gère
    `oldEndpoint` pour rotation), `DELETE /auth/web-push/subscribe`. `notifyMembers`
    dans `socket.js` envoie **EN PLUS** des Expo pushes aux web-pushes, avec le même
    gating (DnD + web/desktop idle ≥ 10 min). Auto-cleanup sur 404/410 dans `sendWebPush`.
    Volume Docker `server-meta:/data/meta` ajouté à `docker-compose.yml`. `.env.example`
    documenté avec bloc VAPID prêt à décommenter (rotation, partage entre instances).

42. **Responsive web (mobile-first) (#46)** — L'app web fonctionne désormais sur
    smartphone, tablette et desktop. Approche : sur mobile (`<md=768px`), un seul
    écran à la fois (Sidebar OU ChannelView), commuté par `activeChannelId` ; sur
    tablette+ (`md+`), les deux côte à côte comme avant. **Aucun useMediaQuery / JS** —
    Tailwind `hidden md:flex` et `flex md:hidden` font tout le travail.
    `App.jsx` enveloppe Sidebar et ChannelView dans des divs responsive et passe
    `onBackToList` à ChannelView. ChannelView affiche un bouton retour `←` dans
    son header en mobile uniquement (`md:hidden`, touch target 44×44). Sidebar
    devient `w-full md:w-72`, items avec padding `py-2.5 md:py-1.5` pour respecter
    les touch targets Apple HIG. Les 11 modales (NewChannel, NewDm, Members,
    AddMembers, Browse, Profile, Invite, Dnd, Search, AdminPanel, Preferences)
    passent en **plein écran sur mobile** (`place-items-stretch` + `w-full h-full`
    + `rounded-none`) et **carte centrée sur sm+** (rounded-xl + max-w-md/lg/2xl).
    Composer reçoit `safe-area-inset-bottom` (iPhone home indicator).

**Tests :** la suite backend (push gating, etc.) reste verte — le test de push mock
le `fetch` global (Expo) qui est inchangé ; l'extension web push est silencieuse
quand aucune `WebPushSubscription` n'existe dans le test DB. `prisma db push` du
globalSetup crée automatiquement la nouvelle table.

**Limites connues / à durcir avant prod :**
- Le service worker précache l'app shell (`workbox-precaching`). En dev (`vite dev`)
  Workbox tourne via `devOptions.enabled` — peut être bruyant à invalider si on
  itère sur le SW lui-même. Préférer `vite build && vite preview` pour valider.
- Sur **Safari iOS**, web push nécessite que l'utilisateur **installe la PWA**
  d'abord ("Ajouter à l'écran d'accueil"). Sinon `Notification.permission` n'est
  même pas exposé. Le bouton "🔔 Activer les notifications" ne s'affiche pas dans
  Safari normal (faute de support) — c'est attendu.
- **HTTPS requis** côté production : Safari refuse `serviceWorker.register` en HTTP
  hors localhost. Le dev se fait via ngrok ou `mkcert` (voir TESTING.md).

43. **Remontée de bug + logs de diagnostic (web/PWA/desktop + mobile)** — Deux
    fonctionnalités jumelles : un buffer de logs client et un formulaire « Signaler
    un bug » qui le consomme. Stockage **DB uniquement** (pas de mailer) — choix
    assumé ; la consultation se fait dans l'Administration (sinon les rapports
    tomberaient dans un trou noir).
    - **Serveur** : modèle Prisma `BugReport` (`userId?` en `onDelete: SetNull` pour
      ne pas perdre un rapport quand l'auteur est supprimé ; `diagnostics Json?`,
      `logs String?`). Routeur `server/src/routes/bugReports.js` : `POST /bug-reports`
      (tout utilisateur authentifié), `GET` (admin, paginé + filtre `status` +
      `openCount`), `PATCH /:id` (statut open/closed), `DELETE /:id` (admin). Caps
      serveur (message 5 KB, logs 100 KB, diagnostics JSON 20 KB → tronqué en
      `{truncated:true}`). 10 tests Vitest (suite 140 → 150).
    - **Buffer de logs** (`logbuffer.js`, un par plateforme) : ring de 300 lignes,
      capture `console.warn/error` + erreurs globales (`window.onerror` /
      `unhandledrejection` web, `ErrorUtils` RN) + breadcrumbs applicatifs (socket
      connect/disconnect/erreur, erreurs API method+path+status, login). En-tête
      diagnostic (version, plateforme, URL serveur, user, état socket, notifs,
      écran, locale/device). **Aucun contenu de message** — événements et IDs
      uniquement. Contexte (serverUrl/user/socket) injecté via `setLogContext` pour
      éviter les imports circulaires (le buffer n'importe pas `api.js`/`version.js`).
    - **UI** : entrée « 🐞 Signaler un bug » dans le menu utilisateur (universelle)
      → modale description + case « joindre les logs » (avec aperçu de ce qui part)
      + boutons « Copier les logs » (presse-papier ; `expo-clipboard` sur mobile) et
      « Télécharger .txt » (web). Version + plateforme **toujours** jointes ; logs
      détaillés seulement si la case est cochée (transparence/RGPD).
    - **Consultation admin** : web → sélecteur d'onglets « Utilisateurs / Rapports
      de bug » dans `AdminPanelModal` ; mobile → écran `BugReports` (menu admin).
      Filtre ouverts/tous, détail dépliable (message + diagnostics + logs), marquer
      résolu / rouvrir, supprimer (avec confirmation).
    - **Dépendance** : `expo-clipboard ~6.0.3` ajoutée côté mobile (version pinnée
      SDK 51 via `bundledNativeModules.json`).
    - Aucun bump de version ni release (règle no-auto-release) ; `prisma db push` du
      boot crée la table `BugReport` automatiquement.

44. **Preview + téléchargement des pièces jointes (web/PWA/desktop + mobile)** —
    Cliquer une PJ ouvrait un onglet/navigateur sur l'URL interne du serveur ;
    désormais ça ouvre une **modale de preview avec bouton télécharger**. _Note :
    le chiffrement at rest des PJ était **déjà** en place (AES-256-GCM dans
    `cryptoFile.js`, flag `Attachment.encrypted`, déchiffrement à la volée au
    download) — rien à refaire de ce côté._
    - **Serveur** : `GET /uploads/:id` accepte `?download=1` →
      `Content-Disposition: attachment` (au lieu d'`inline`) pour forcer un vrai
      téléchargement avec le bon nom de fichier ; sans le paramètre, l'inline
      permet à `<img>/<video>/<iframe>` de prévisualiser. Test ajouté (suite 150 → 151).
    - **Web/PWA/desktop** : `AttachmentModal.jsx` (lightbox plein écran) prévisualise
      image / vidéo (`<video controls>`) / audio / PDF (`<iframe>`) ; types non gérés
      → carte « aperçu indisponible » + bouton. Téléchargement : web via une ancre
      vers `?download=1` ; desktop via le plugin opener (sinon la webview Tauri avale
      la navigation, cf #43). `ChannelView` ouvre la modale au clic au lieu de
      `<a target="_blank">`.
    - **Mobile (Android)** : `AttachmentModal.js` — image (`<Image>`) et vidéo
      (`expo-av <Video>`) en preview in-app, audio via les contrôles natifs ;
      PDF/autres → téléchargement (`expo-file-system`) puis partage/ouverture via
      l'OS (`expo-sharing`), la WebView Android ne rendant pas les PDF inline.
      `MessageItem` ouvre la modale au lieu de `Linking.openURL`.
    - **Dépendances mobiles** : `expo-av ~14.0.7`, `expo-file-system ~17.0.1`,
      `expo-sharing ~12.0.1` (pins SDK 51) → APK à rebuild à la prochaine release.
    - Aucun bump de version ni release (règle no-auto-release).

45. **Sélecteur de GIF (GIPHY) — web/PWA/desktop + mobile)** — Bouton GIF dans le
    Composer → recherche/tendances → clic envoie le GIF. Un GIF = une pièce jointe
    `image/gif`, donc réutilise tout le pipeline (chiffré at rest + rendu inline +
    modale de preview). **Provider : GIPHY** ; **stockage : ré-hébergement chiffré**
    (le GIF choisi est téléchargé puis stocké comme attachment — les destinataires
    ne touchent jamais le CDN GIPHY, pas de lien mort).
    - **Serveur** : `routes/gifs.js` — `GET /gifs/search?q=&pos=` (proxy GIPHY, clé
      `GIPHY_API_KEY` **lue côté serveur uniquement**, rating `GIF_RATING` ; `q` vide
      = tendances), `POST /gifs/import {url}` (⚠️ **anti-SSRF** : URL restreinte aux
      hôtes `*.giphy.com` + https, cap 25 Mo, content-type image/*), `GET /gifs/config`.
      L'import réutilise `storeEncryptedAttachment` (extrait de `uploads.js` →
      source unique pour upload + GIF). 6 tests Vitest (auth, SSRF, not_configured,
      search & import mockés) ; suite 151 → 157.
    - **Web/PWA/desktop** : `GifPicker.jsx` (popover : recherche debouncée + grille
      masonry de miniatures GIPHY + « Powered by GIPHY » + pagination). Bouton GIF
      dans `Composer` → au clic, `importGif(fullUrl)` puis envoi immédiat
      `{ body:"", attachmentIds:[id] }` (UX GIF classique, ne touche pas au texte en cours).
    - **Mobile (Android)** : `GifPicker.js` (modal plein écran, grille FlatList).
      Bouton GIF dans le Composer (qui était text-only) → import + `onSend` immédiat.
      **`expo-image`** (`~1.13.0`, pin SDK 51) remplace `<Image>` RN dans
      `MessageItem` + `AttachmentModal` pour **animer les GIF sur Android** (Fresco
      core ne les anime pas).
    - **Config** : `GIPHY_API_KEY` + `GIF_RATING` dans `.env.example` + `docker-compose.yml`.
      Sans clé → recherche désactivée proprement (« non configuré »).
    - APK à rebuild à la prochaine release (`expo-image`). Aucun bump de version ni release.

46. **Fix : staleness du service worker sur desktop (Tauri)** — Après install de la
    0.6.0, le desktop montrait encore l'ancien front (pas de bouton GIF + bannière
    de MAJ) ; un Ctrl+F5 corrigeait. Cause : la webview Tauri enregistrait le
    **service worker de la PWA**, qui précache l'app shell et continue de le servir
    après mise à jour (même classe de bug que le « Rafraîchir » web, #64, mais sans
    refresh facile). Le desktop n'a aucun besoin du SW (front embarqué en local,
    notifs via Tauri). Fix dans `pwa.js` : `ensurePwaReady()` **n'enregistre jamais**
    le SW sous `isTauri()` et **purge** tout SW + Cache Storage existant
    (`teardownServiceWorker`) pour soigner les installs déjà touchées. Web/PWA (vrai
    navigateur, iOS A2HS) inchangés. `injectRegister: false` côté vite-plugin-pwa →
    gater ce seul point suffit. Transition : sur la 1ʳᵉ build avec ce fix, un dernier
    Ctrl+F5 charge le code de purge, puis le SW disparaît définitivement.

## Itération 2026-06-17 — correctifs 0.6.1 (GIF, bannière de MAJ)

47. **GIF « server_error » à l'envoi** — envoyer un GIF renvoyait `server_error`. Cause :
    le client lisait `att.id` (undefined) au lieu de `att.attachment.id` dans la réponse
    `importGif`, et Prisma plantait sur un `where id in [undefined]`. Fix : les Composer web +
    mobile destructurent `{ attachment }` et utilisent `attachment.id` ; + garde serveur dans
    `message:send` (sanitisation des `attachmentIds` → ne garde que des ids string non vides).
    Découvert via un test de repro (qui passait, car il utilisait le bon chemin).
48. **Bannière de MAJ en bas sur mobile** — sur web/PWA mobile, la bannière « Nouvelle
    version » masquait le header ; repositionnée en bas (`order-last md:order-none` + safe-area).
    Le bouton « Rafraîchir » fait un **hardReload** (purge des Cache Storage + `SKIP_WAITING`
    du SW) pour ne pas re-servir l'app shell précachée (sinon la bannière revenait en boucle).

## Itération 2026-06-22 — fiabilité push PWA, badge tray, install PWA, CI allégée (0.6.2)

49. **iOS web push — `VAPID_SUBJECT` réel** — un compte sur iOS + Android ne recevait le push
    que sur Android. Cause : `VAPID_SUBJECT` au défaut `mailto:admin@murgat-chat.local` ;
    Apple (`web.push.apple.com`) **valide le claim `sub` du JWT VAPID et rejette** un sujet
    non routable (FCM l'ignore → Android marchait). Fix : `VAPID_SUBJECT` = vraie adresse
    (`mailto:lesfontaines@charlesmurgat.com`) + restart serveur. **Pas de re-souscription** —
    le sujet est signé à l'**envoi**, pas à la souscription ; ne pas toucher aux clés VAPID.
50. **Fiabilité du push PWA (#72)** — le push pouvait mettre jusqu'à 10 min à reprendre après
    mise en arrière-plan du téléphone. La fenêtre « away » de `webDesktopInactive` passe de
    **10 min à ~150s** (`AWAY_AFTER_MS`) : c'est ce fallback qui relance vraiment le push pour
    un téléphone fraîchement backgroundé (le signal « away » du PWA n'est pas fiable, l'OS
    suspend le JS avant le flush). Côté client, **re-souscription au retour au premier plan**
    (`resubscribeIfNeeded` dans `pwa.js`) si l'abonnement a expiré/été élagué.
51. **Badge non-lu sur l'icône du tray — desktop (#74)** — un point rouge est peint sur
    l'icône du tray Tauri à la réception d'un message (fenêtre non focus), effacé au retour du
    focus. Pur Rust (disque RGBA peint sur l'icône par défaut, pas de second asset), via une
    commande `set_tray_badge` invoquée depuis le front (no-op web/PWA).
52. **Bannière « Installer la PWA » — mobile web (#73)** — sur navigateur mobile (hors Tauri,
    hors PWA déjà installée), une bannière dismissible en bas invite à installer la PWA
    (Android : bouton via `beforeinstallprompt` ; iOS Safari : instructions Partager → Ajouter
    à l'écran d'accueil). Dismiss persisté en `localStorage`.
53. **CI de release allégée — plus d'APK (#75)** — le job `android` est retiré de
    `release.yml` (mobile = PWA-only depuis le pivot) → release plus rapide. La release ne
    build plus que l'installeur desktop ; la validation de version ne vérifie plus que les **3
    fichiers web/desktop** (`web/package.json`, `tauri.conf.json`, `Cargo.toml`).

## Itération 2026-06-23 — notifs desktop, dernière conversation, recherche unifiée, install & auto-update (0.6.3 + 0.6.4)

54. **Fix présence desktop « tray » — notifs (0.6.3, #78)** — diagnostiqué via un log serveur
    (`[push] notifying 0 native + 1 web for 1 away user(s)` sur une conv à 3 membres tous
    masqués dans le tray). **Cause racine commune** : une fenêtre Tauri masquée dans le tray
    garde `document.visibilityState='visible'` ET `document.hasFocus()=true`. Deux symptômes :
    (1) le heartbeat `activity` continuait d'annoncer le desktop « actif » → la passerelle away
    (par utilisateur) **coupait le push vers le téléphone du même compte** ; (2)
    `isWindowFocused()` renvoyait `true` → `onNotif` supprimait **toast ET point rouge**
    (« rien du tout, même pas le point rouge »). Fix : suivi de l'état natif réel
    (`isVisible`/`isMinimized`/`isFocused` + `onFocusChanged`, poll 20s de secours) dans
    `desktop.js`, exposé via `isAppHidden()` (pilote le heartbeat) et un `isWindowFocused()`
    **Tauri-aware** ; capabilities `core:window:allow-is-visible/-is-minimized/-is-focused`.
    Navigateur/PWA inchangés (Page Visibility API). **Bug latent**, pas une régression. En
    prime : init notifs Windows plus robuste (ne capitule plus si la permission se lit « non
    accordée » — faux négatif fréquent sous Windows). Validé en live (build DevTools).
55. **Réouverture sur la dernière conversation (0.6.3, #77)** — tous les clients rouvrent sur
    la dernière conversation **vue** au lieu du premier salon. `activeChannelId` persisté en
    `localStorage` par utilisateur (`murgat:lastChannel:<userId>`), restauré au chargement s'il
    existe encore (sinon premier salon). Un deep-link de notif (`?channel=`) reste prioritaire.
56. **Recherche unifiée (« quick switcher ») + retrait de la recherche de messages (0.6.4, #80)**
    — un **seul champ** en haut de la sidebar remplace les boutons parcourir-salons +
    nouveau-salon + nouveau-DM. Vide → listes normales ; en tapant → résultats groupés : vos
    conversations (switch), salons publics à rejoindre, personnes (→ DM direct), et actions
    « Créer le salon … » (ouvre le formulaire **pré-rempli**) / « Nouveau groupe ». **Insensible
    aux accents** (« gen » trouve « Général »). Nouveau `QuickSwitcher.jsx`. La **recherche de
    messages est retirée** (bouton 🔍 + raccourci Ctrl/Cmd+K + `SearchModal` supprimés ;
    `BrowseChannelsModal` aussi, fondu dans la recherche) — la route backend `/search` est
    laissée en place (inoffensive). E2E ajusté (création de salon via la recherche). Validé en
    live contre le stack.
57. **Bouton retour du téléphone → liste (0.6.4, #80)** — sur mobile/PWA, le bouton retour
    système quand on est sur une conversation la **ferme** (réaffiche la liste) au lieu de
    quitter l'app, via un sentinel History (push à l'ouverture d'une conversation, `popstate` →
    désélection). No-op en layout desktop/tablette (2 volets). Le bouton retour in-app passe
    par le même `history.back()` pour rester synchro.
58. **Installation tous-utilisateurs / TSE (0.6.4, #83)** — NSIS `installMode: "both"` dans
    `tauri.conf.json` : l'installeur laisse choisir « Moi seul » (per-user, sans admin) ou
    « Tous les utilisateurs » (perMachine, élévation) — pour un usage Terminal Server (RDS).
59. **Auto-updater desktop signé (0.6.4, #83)** — plugin **updater Tauri** : au lancement,
    l'app interroge `latest.json` (GitHub Releases, endpoint `/releases/latest/download/latest.json`),
    télécharge la version **signée**, l'installe et relance. Config : `bundle.createUpdaterArtifacts`
    + `plugins.updater` (endpoint + `pubkey`) ; plugins Rust `tauri-plugin-updater` +
    `tauri-plugin-process` ; capabilities `updater:default` + `process:allow-restart` ; deps JS
    `@tauri-apps/plugin-updater` + `plugin-process`. La bannière de MAJ **desktop installe** en
    place (download → install → relaunch) au lieu d'ouvrir un lien ; le web/PWA garde
    « Rafraîchir ». `release.yml` + `desktop-installer.yml` signent via le secret
    **`TAURI_SIGNING_PRIVATE_KEY`** (clé privée **hors repo** : `~/.tauri/murgatchat_updater.key`,
    **à sauvegarder** — la perdre casse l'auto-update des installs existantes ; clé publique
    committée dans `tauri.conf.json`). ⚠️ `createUpdaterArtifacts` ⇒ **tout** build desktop
    (y compris le test) exige le secret. MAJ auto **fluide pour les installs per-user** ;
    **perMachine/TSE** (Program Files) demande l'admin → MAJ gérées centralement par l'admin.
    **Vers l'avant uniquement** : 0.6.4 = dernière install manuelle, puis 0.6.4 → 0.6.5+
    automatique. `latest.json` de la release vérifié valide + signé.

> **Releases récentes** (desktop-only depuis le pivot PWA, installeur NSIS attaché à la
> GitHub Release) : **0.6.0** (remontée de bug, preview/téléchargement des PJ, GIF),
> **0.6.1** (#46–48), **0.6.2** (#49–53), **0.6.3** (#54–55), **0.6.4** (#56–59, premier
> installeur **signé** + `latest.json` → point de départ de l'auto-update).
