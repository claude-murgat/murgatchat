# Chat — un clone Slack-like

Copie graphiquement inspirée de Slack avec :

- **Backend** Node.js (Express + Socket.IO) + Prisma + PostgreSQL
- **Web** React + Vite + Tailwind (thème aubergine de Slack)
- **Desktop** Tauri 2 (Windows / macOS / Linux) — réutilise le React, ajoute system tray + notifications natives
- **Mobile** React Native via Expo (Android d'abord, iOS prêt à activer)
- **Docker** `docker-compose` pour DB + backend + web
- **Fonctionnalités** : auth JWT, salons publics/privés, messages directs (+ auto-DM « notes pour soi »), *Ne pas déranger*, **messages planifiés** (créer / modifier / supprimer), réponses inline (citation cliquable), **rendu Markdown** (GFM : gras, code inline + blocs colorés, listes, liens, tables…), **pièces jointes chiffrées at-rest** + bodies chiffrés (AES-256-GCM), recherche full-text, notifications temps réel, **notifications système** (toast Windows/macOS via Tauri ou API browser)

```
.
├── docker-compose.yml
├── server/         # API + WebSocket + Prisma
├── web/            # client React (Slack look)
│   └── src-tauri/  # wrapper desktop (Rust + Tauri 2)
└── mobile/         # app Expo (Android, iOS prêt)
```

> Les installeurs (Windows `.exe`, Android `.apk`) ne sont **pas** versionnés dans le dépôt : ils sont buildés par CI et publiés dans les [GitHub Releases](../../releases) au push d'un tag `v*`.

## Démarrage avec Docker

Pré-requis : Docker + Docker Compose.

```bash
docker compose up --build
```

- Web : http://localhost:5173 (et http://&lt;IP-LAN&gt;:5173 depuis le réseau)
- API : http://localhost:4000 (`/health` pour vérifier)
- Postgres exposé sur `localhost:5433` (le `5432` interne du container)

> Le client web fait des appels XHR + WebSocket vers le backend ; comme ces URL sont **bakées dans le bundle à la build**, le compose pointe par défaut sur l'IP LAN `172.16.2.192:4000` (à adapter à ta machine). Pour la changer :
>
> ```bash
> VITE_API_URL=http://10.0.0.42:4000 docker compose up -d --build web
> ```

Au démarrage, le serveur exécute `prisma db push` pour synchroniser le schéma (voir [Migrations](#migrations) pour le pourquoi).

### Premiers pas

1. Crée deux comptes depuis l'écran d'inscription (un dans une fenêtre privée pour tester en parallèle).
2. `+` à côté de *Salons* → créer un salon, inviter des membres.
3. `+` à côté de *Messages directs* → démarrer un DM.
4. Composer :
   - `📎 Fichier` ou Cmd/Ctrl+V → joindre un fichier (jusqu'à 25 Mo)
   - `⏰ Planifier` → choisir date/heure d'envoi
   - *Entrée* envoie, *Shift+Entrée* retour à la ligne
5. Header du salon → `Planifiés (N)` → liste éditable de tes messages programmés.
6. Menu utilisateur (en haut à gauche) → *Activer Ne pas déranger*.

## Démarrage en local (sans Docker)

### Postgres

```bash
docker run --rm -p 5432:5432 \
  -e POSTGRES_USER=chat -e POSTGRES_PASSWORD=chatpass -e POSTGRES_DB=chat \
  postgres:16-alpine
```

### Backend

```bash
cd server
npm install
export DATABASE_URL="postgresql://chat:chatpass@localhost:5432/chat?schema=public"
export JWT_SECRET=dev-secret
export MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
export UPLOAD_DIR=./uploads
npx prisma db push
npm run dev
```

### Web

```bash
cd web
npm install
VITE_API_URL=http://localhost:4000 npm run dev
```

### Mobile (Expo)

```bash
cd mobile
npm install
npx expo start
```

L'adresse du serveur se saisit **dans l'app** (écran de connexion) ; aucun serveur n'est baké (`extra.API_URL=""`). Pour l'émulateur Android, l'hôte est `http://10.0.2.2:4000` (alias émulateur → machine) ; pour un device physique, l'IP LAN de ta machine. iOS s'active dès `expo run:ios` sur macOS.

### Desktop (Tauri — Windows / macOS / Linux)

**Installeur Windows + APK** : téléchargez-les depuis la section **[Releases](../../releases)** du dépôt. Chaque release est buildée automatiquement par CI au push d'un tag `v*` (voir [Releases automatisées](#releases-automatisées-ci)). L'installeur NSIS est non signé (SmartScreen avertit une fois). L'adresse du serveur se configure **dans l'app** (écran de connexion) ; les builds ne bakent **aucun serveur par défaut** (champ vide au premier lancement).

Le scaffold complet est dans [web/src-tauri/](web/src-tauri/). Tauri lance Vite en dev et embarque le `dist/` en release.

**Pré-requis Windows :**
- Rust stable via [rustup.rs](https://rustup.rs/)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (présent par défaut sur Windows 11, déjà installé via Edge sur Windows 10 récent)
- Microsoft C++ Build Tools (cocher *Desktop development with C++* dans Visual Studio Installer)
- Node 20+

Sur macOS/Linux : Rust + Xcode CLT (macOS) ou paquets webkit2gtk (Linux). Voir [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/).

**Lancer en dev :**

```bash
cd web
npm install
npm run tauri:dev          # ouvre la fenêtre native, hot-reload via Vite
```

L'app pointe par défaut vers `http://localhost:4000` pour l'API. Lance la stack backend en parallèle (`docker compose up db server`).

**Builder le bundle Windows (local, optionnel) :**

```bash
cd web
npm run tauri:build -- --bundles nsis   # → web/src-tauri/target/release/bundle/nsis/Chat_*.exe
```

En MSVC (toolchain standard, ce que fait la CI), `WebView2Loader.dll` est liée statiquement — rien à embarquer. Les releases officielles sont produites par CI (`windows-latest`, MSVC) ; un build local n'est utile que pour déboguer.

### Releases automatisées (CI)

Le workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) se déclenche au **push d'un tag `v*`** et publie une GitHub Release avec l'installeur Windows et l'APK signée.

Pipeline : `test` (réutilise [`tests.yml`](.github/workflows/tests.yml)) → `release` (crée une release *draft* + valide que les 5 fichiers de version == tag) → `desktop` (`windows-latest`, MSVC, `tauri-action`) **et** `android` (`ubuntu-latest`, `expo prebuild` + APK signée) en parallèle → `publish` (passe la release en *live*).

**Couper une release :**
```bash
# 1. bumper la version dans les 5 fichiers : web/package.json, mobile/package.json,
#    mobile/app.json (expo.version), web/src-tauri/tauri.conf.json, web/src-tauri/Cargo.toml
# 2. merger sur main, puis :
git tag v0.5.3 && git push origin v0.5.3
```
Le `versionName` vient du tag ; le `versionCode` Android est dérivé du semver (`MAJ*10000+MIN*100+PAT`, monotone). Le build desktop/APK ne bake **aucun serveur** (pas de `VITE_API_URL`, `extra.API_URL=""`).

**Secrets requis** (Settings → Secrets and variables → Actions) pour signer l'APK avec une **keystore d'upload stable** (sinon les MAJ ne s'installent pas par-dessus) :

| Secret | Contenu |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | la keystore encodée base64 |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du store |
| `ANDROID_KEY_PASSWORD` | mot de passe de la clé |
| `ANDROID_KEY_ALIAS` | alias (`murgat-upload`) |

Générer la keystore (**une seule fois, à sauvegarder hors-ligne à vie**) :
```bash
keytool -genkeypair -v -keystore upload.keystore -alias murgat-upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass '<store-pass>' -keypass '<key-pass>' \
  -dname "CN=Murgat Chat, O=Murgat, C=FR"
# PowerShell : [Convert]::ToBase64String([IO.File]::ReadAllBytes("upload.keystore")) | Set-Content upload.keystore.b64 -NoNewline
```
La signature release est câblée par le config-plugin [`mobile/plugins/withReleaseSigning.js`](mobile/plugins/withReleaseSigning.js) (fallback debug en local si les secrets sont absents, donc un build local reste possible).

### Bannière de mise à jour (version checker)

Le serveur expose `GET /version` → `{ version, downloadUrl }`, piloté par les variables d'env **`CLIENT_VERSION`** (la version publiée à annoncer) et **`DOWNLOAD_URL`** (lien du bouton desktop ; défaut = page Releases). Chaque client compare sa version embarquée à celle annoncée — **au démarrage, au focus, toutes les 15 min** — et affiche une bannière si une version plus récente existe :

| Plateforme | Action proposée |
| --- | --- |
| Web | **Rafraîchir** (recharge le bundle déjà servi) |
| Desktop (Tauri) | **Télécharger** (ouvre `DOWNLOAD_URL`) |
| Android | bannière d'info seule (pas d'action) |

Sans `CLIENT_VERSION`, le serveur renvoie sa propre version (basse) → aucune bannière (checker inactif). Pour tester : `CLIENT_VERSION=0.5.3 docker compose up -d server`, puis ouvrir un client plus ancien.

**Comportements desktop :**

- **System tray** — icône aubergine `#` ; clic gauche bascule afficher/masquer la fenêtre, clic droit ouvre un menu *Afficher / Masquer / Quitter*.
- **Fermer ≠ quitter** — la croix de la fenêtre la masque dans la tray, l'app continue de tourner et de recevoir les messages.
- **Notifications natives** — quand un message arrive alors que la fenêtre n'a pas le focus, un toast Windows apparaît via le plugin [tauri-plugin-notification](https://v2.tauri.app/plugin/notification/). En navigateur classique (sans Tauri), [web/src/desktop.js](web/src/desktop.js) bascule sur l'API `Notification` du navigateur.
- **Permission notification** — demandée au premier login. Si elle est refusée, seul le toast in-app reste.

**Auto-start au boot Windows :** placer un raccourci vers `Chat.exe` dans `shell:startup` (Win+R → `shell:startup`). Pour une intégration plus propre via le registre, on pourrait ajouter le plugin [tauri-plugin-autostart](https://v2.tauri.app/plugin/autostart/) — pas activé pour l'instant.

Icônes : sources dans [web/src-tauri/icons/](web/src-tauri/icons/) ; pour les régénérer depuis un PNG source, `npm run tauri icon path/to/source.png`.

## Architecture en bref

```
                    +----------------+
   web (React) <--> |   server :4000 |  <--> Postgres (db-data)
                    | Express +      |   \-- uploads (uploads-data)
   mobile (RN) <--> | Socket.IO +    |
                    | Prisma         |
                    +----------------+
```

### Real-time
Socket.IO. Le client rejoint `user:<id>` (notifs perso) et `channel:<id>` (messages). Le serveur émet :
- `message:new` → tous les sockets dans `channel:<id>`
- `notification` → `user:<id>` des destinataires hors-salon **non DnD**
- `channel:created` → `user:<id>` de chaque nouveau membre, qui est aussi auto-abonné (`socketsJoin`) au nouveau channel sans refresh.

### Messages planifiés
Un message avec `scheduledAt > now` est créé `delivered=false`. Un dispatcher tourne toutes les 10 s ([server/src/index.js](server/src/index.js)) :
- requête `WHERE delivered=false AND scheduledAt <= now()`
- pour chaque message dû : `UPDATE delivered=true, createdAt=scheduledAt` puis émission `message:new`.

> Le `createdAt` est réécrit avec `scheduledAt` à la livraison, pour que l'heure affichée dans le fil soit celle prévue par l'auteur — pas celle où le message a été mis en file d'attente.

L'auteur peut lister / modifier / supprimer ses planifications :
- `GET /channels/:id/scheduled`
- `PATCH /channels/scheduled/:id` (body, scheduledAt)
- `DELETE /channels/scheduled/:id`

### Ne pas déranger
`User.dndUntil` (timestamp). Le serveur ignore `notification` pour les destinataires en DnD ; les messages restent stockés et visibles à l'ouverture du salon.

### Chiffrement des messages
**Décision : chiffrement at-rest, pas E2E.**

- AES-256-GCM, clé symétrique côté serveur ([server/src/crypto.js](server/src/crypto.js)).
- Clé via `MESSAGE_ENCRYPTION_KEY` (64 hex). Si absente, dérive une clé dev d'un mot de passe constant et logue un warning — **inacceptable en prod**.
- Format stocké : `enc1:<base64(iv(12) || tag(16) || ciphertext)>`.
- Décryptage transparent dans `serializeMessage`/`serializeScheduled` ; les anciens bodies plaintext restent lisibles (fallback).
- Couvre : messages, dernier message de canal, liste planifiée. **Ne couvre pas** : nom du salon, displayName des utilisateurs, contenu des pièces jointes (voir ci-dessous).

E2E (le serveur ne peut pas lire) a été écarté pour cette itération car incompatible avec :
- messages planifiés côté serveur (le serveur devrait pré-chiffrer pour chaque destinataire),
- recherche full-text future,
- prévisualisation de notifications avec le contenu.
À reprendre quand on aura clarifié quels canaux veulent quelle garantie (ex. : E2E uniquement pour les DM, planification désactivée dans ce cas).

### Pièces jointes
- Upload `multipart/form-data` via `POST /uploads` (multer, **25 Mo max** par fichier).
- Stockage disque dans `UPLOAD_DIR` (volume Docker `uploads-data` monté sur `/data/uploads`).
- Téléchargement / aperçu `GET /uploads/:id?token=<jwt>` — auth + check d'appartenance au salon du message lié (ou être l'uploader si pas encore attaché). `?download=1` force le téléchargement (`Content-Disposition: attachment`) au lieu de l'inline.
- UI Composer : bouton `📎 Fichier`, picker multi-sélection, **collage Cmd/Ctrl+V** (capture d'écran ou n'importe quel fichier dans le presse-papier).
- Rendu : miniature pour les images (`image/*`), pavé icône + nom + taille pour les autres types. **Clic → modale de preview** (image / vidéo / audio / PDF) avec bouton Télécharger. Sur mobile (Android), image+vidéo en in-app ; PDF et autres types sont téléchargés puis ouverts/partagés via l'OS (`expo-file-system` + `expo-sharing`).
- Encodage des noms : multer décode en latin1 par défaut → reconverti côté serveur en UTF-8 pour préserver accents/apostrophes.

**Chiffrement at rest : oui.** Les blobs sont chiffrés en **AES-256-GCM** (`cryptoFile.js`, même clé que les bodies de messages) au format `[version][iv][ciphertext][tag]`, et déchiffrés à la volée au download (`Attachment.encrypted=true`). Les blobs antérieurs au rollout du chiffrement restent servis en clair (`encrypted=false`).

### Schéma de données
Tables (Prisma) :
- `User` (id, email, username, displayName, passwordHash, avatarColor, status, dndUntil)
- `Channel` (id, name?, isDirect, isPrivate, description?)
- `Membership` (userId, channelId, joinedAt, lastReadAt) — unique sur la paire
- `Message` (id, channelId, authorId, body **(chiffré)**, createdAt, scheduledAt?, delivered) — indices `(channelId,createdAt)` et `(scheduledAt,delivered)`
- `Attachment` (id, messageId?, uploadedBy, filename, mimeType, size, storagePath, createdAt) — indices `(messageId)` et `(uploadedBy)`

### Migrations
**Décision : `prisma db push`** au démarrage, pas de fichiers de migration committés. C'est volontaire pour un MVP — itération rapide sans dossier `prisma/migrations/` à maintenir.

Pour passer en production : générer un dossier de migrations versionné (`prisma migrate dev --name init`, commit), puis remplacer la commande du `Dockerfile` par `prisma migrate deploy`.

## Variables d'environnement (server)

| nom                        | défaut                  | rôle                                              |
|----------------------------|-------------------------|---------------------------------------------------|
| `DATABASE_URL`             | (requis)                | URL Postgres                                      |
| `JWT_SECRET`               | `dev-secret`            | secret des tokens                                 |
| `MESSAGE_ENCRYPTION_KEY`   | (dérivée dev + warning) | 64 hex (32 octets) pour AES-256-GCM               |
| `UPLOAD_DIR`               | `/data/uploads`         | répertoire de stockage des PJ                     |
| `PORT`                     | `4000`                  | port HTTP                                         |
| `CORS_ORIGIN`              | `*`                     | origine CORS autorisée                            |

Génère une clé prod avec : `openssl rand -hex 32`.

## Endpoints HTTP

| Méthode | Route                              | Description                                  |
|---------|------------------------------------|----------------------------------------------|
| GET     | `/health`                          | liveness                                     |
| POST    | `/auth/register`                   | inscription                                  |
| POST    | `/auth/login`                      | connexion                                    |
| GET     | `/auth/me`                         | utilisateur courant                          |
| POST    | `/auth/dnd`                        | `{ minutes }` (0 = désactive DnD)            |
| GET     | `/users?q=`                        | recherche d'utilisateurs                     |
| GET     | `/channels`                        | mes conversations                            |
| POST    | `/channels`                        | créer un salon                               |
| POST    | `/channels/dm`                     | ouvrir ou retrouver un DM                    |
| GET     | `/channels/:id/messages`           | messages d'un salon                          |
| GET     | `/channels/:id/scheduled`          | mes messages planifiés dans le salon         |
| PATCH   | `/channels/scheduled/:id`          | modifier un planifié (body, scheduledAt)     |
| DELETE  | `/channels/scheduled/:id`          | annuler une planification                    |
| POST    | `/uploads`                         | upload multipart (champ `file`, ≤ 25 Mo)     |
| GET     | `/uploads/:id?token=<jwt>`         | aperçu (inline) d'une PJ ; `&download=1` force le téléchargement |
| POST    | `/bug-reports`                     | signaler un bug (`{ message, logs?, diagnostics?, appVersion?, platform? }`) |
| GET     | `/bug-reports?status=&page=`       | lister les rapports (admin)                  |
| PATCH   | `/bug-reports/:id`                 | changer le statut `open`/`closed` (admin)    |
| DELETE  | `/bug-reports/:id`                 | supprimer un rapport (admin)                 |
| GET     | `/gifs/search?q=&pos=`             | recherche/tendances GIF (proxy GIPHY, clé serveur) |
| POST    | `/gifs/import`                     | ré-héberge le GIF choisi (`{ url }`) comme PJ chiffrée |

### Sélecteur de GIF (GIPHY)

Bouton **GIF** dans le Composer (web/PWA/desktop + mobile) → recherche/tendances, clic = envoi. La clé `GIPHY_API_KEY` vit **uniquement côté serveur** (proxy `/gifs/search`, jamais dans le bundle client) ; le filtre de contenu est réglable via `GIF_RATING`. Le GIF choisi est **ré-hébergé chiffré** : le serveur le télécharge (URL restreinte aux hôtes `*.giphy.com`, anti-SSRF) et le stocke comme pièce jointe `image/gif` — donc chiffré at rest, rendu inline + modale de preview, et les destinataires ne touchent jamais le CDN GIPHY. Sans clé, la recherche est désactivée proprement (« non configuré »). Sur mobile, `expo-image` anime les GIF (Android).

### Remontée de bug & logs de diagnostic

Le menu utilisateur expose **« 🐞 Signaler un bug »** sur toutes les plateformes
(web, PWA, desktop, mobile). Le client tient un **buffer de logs en mémoire**
(`logbuffer.js` : ~300 lignes ; `console.warn/error`, erreurs globales et
breadcrumbs socket/API — **jamais de contenu de message**) ; l'utilisateur peut le
copier, le télécharger (`.txt`, web) ou le joindre au rapport. Les rapports sont
**stockés en base** (`BugReport`) — pas d'e-mail — et consultés par les admins dans
**Administration → Rapports de bug** (filtre ouverts/tous, marquer résolu, supprimer).

#### Conversation de support in-app (Claude raffine le ticket)

Optionnel. Si `ANTHROPIC_API_KEY` est configuré, « Signaler un bug » lance une
**conversation avec Claude côté serveur** (`server/src/anthropic.js`,
`server/src/routes/support.js`, modèle `SupportConversation`) : Claude pose quelques
questions de clarification puis, une fois la demande précise, **finalise** le ticket
via un outil `submit_ticket`. La finalisation crée le `BugReport` (avec la description
raffinée) et l'issue GitHub — c.-à-d. l'entrée du pipeline ci-dessous. La clé API
n'est **jamais** exposée au client. Clé absente ⇒ le bouton retombe automatiquement
sur l'**envoi direct** d'un signalement brut (comportement historique).

#### Pipeline automatisé signalement → issue → PR (Claude)

Optionnel. Si `GITHUB_BUG_TOKEN` est configuré, le ticket finalisé est **miroité**
vers une **issue GitHub** (label `signalement`) — best-effort, sans jamais bloquer la
soumission (cf. `server/src/github.js`). Le lien de l'issue est stocké sur le rapport
et affiché dans le panneau admin. Cette issue déclenche les workflows GitHub Actions
(`.github/workflows/`) :

1. **`claude-triage.yml`** — Claude lit la description + les logs, explore le code,
   réécrit l'issue en rapport structuré, puis — si actionnable — pose le tag
   **`à-valider`** et **s'arrête** (sinon `besoin-info` / `wontfix`). Il ne lance pas
   le codage tout seul.
2. **Validation humaine** — un développeur de l'équipe relit le rapport et, pour
   autoriser le correctif automatique, pose lui-même le tag **`claude:fix`**. C'est le
   gate de validation du pipeline.
3. **`claude-fix.yml`** — déclenché par `claude:fix`, Claude implémente un correctif
   sur une branche et ouvre une **PR** (`Fixes #N`) laissée en **attente de revue**.
4. **Revue** — un humain relit la PR ; il peut ensuite demander une **seconde passe
   IA** en posant le tag **`revue-ia`**, qui déclenche **`claude-review.yml`** : Claude
   poste une revue consultative (sans jamais approuver ni merger). Le merge en prod
   reste une décision humaine. (`claude.yml` permet aussi d'itérer via `@claude`.)

Mise en service (une fois, **en tant que propriétaire du dépôt** — droits admin requis
pour les secrets) :

- **PAT GitHub** (`GH_BOT_TOKEN`) : un *personal access token* d'un compte ayant
  l'écriture sur le dépôt. Fine-grained avec, sur ce dépôt, *Contents*, *Issues* et
  *Pull requests* en **Read & write** (ou un PAT classique scope `repo`). Le PAT agit
  comme un utilisateur réel : c'est lui qui fait que le label `claude:fix` déclenche
  `claude-fix.yml` et que la PR déclenche la CI `tests.yml` (le token `github-actions`
  par défaut ne le ferait pas). **Aucune App GitHub à installer.**
- **Secrets repo** (Settings → Secrets and variables → Actions) :
  `CLAUDE_CODE_OAUTH_TOKEN` (accès modèle, généré par `claude setup-token`) et
  `GH_BOT_TOKEN` (le PAT ci-dessus).
- **Variables serveur** (`.env`, voir `.env.example`) : `GITHUB_BUG_TOKEN` (peut être
  le même PAT ; *Issues: write* suffit pour le pont), `GITHUB_REPO_OWNER`,
  `GITHUB_REPO_NAME`. Token vide ⇒ pont désactivé (comportement historique).
  `ANTHROPIC_API_KEY` (+ `SUPPORT_MODEL`, défaut `claude-opus-4-8`) pour la
  conversation de support ; clé vide ⇒ envoi direct (chat désactivé).
- **Labels** à créer : `signalement`, `à-valider`, `claude:fix`, `revue-ia`,
  `besoin-info` (`wontfix`/`duplicate`/`bug` existent déjà). Ex. :
  `gh label create "claude:fix" -c "#0e8a16" -d "Autorise le développement par Claude"`,
  `gh label create "à-valider" -c "#fbca04" -d "Triage fait, en attente de validation dev"`,
  `gh label create "revue-ia" -c "#5319e7" -d "Demande une revue IA de la PR"`.

## Événements Socket.IO

Côté client → serveur : `channel:join`, `channel:read`, `message:send` (`{ channelId, body?, attachmentIds?, scheduledAt? }`).
Côté serveur → client : `message:new`, `channel:created`, `notification`.

## Décisions techniques

Récap des choix faits pendant le build (et pourquoi), pour qu'on puisse les remettre en question facilement.

### Stack
- **Tauri 2 plutôt qu'Electron** pour le desktop : bundle ~3 Mo (vs ~150), WebView2 déjà présent sur Windows 10+, Rust backend, supporté en cross-compile depuis Linux. Coût : Rust à installer pour builder.
- **Expo pour le mobile** : un seul codebase Android + iOS. iOS prêt sans réécriture, juste `expo run:ios` sur macOS.
- **Prisma + Postgres** plutôt que Mongo/SQLite : relations natives (messages × channels × users × attachments), index, robuste pour l'historique.

### Auth & sécurité
- **JWT 30j sans refresh token** pour la simplicité MVP. À ajouter dès qu'on veut une vraie politique d'expiration.
- **CORS `*`** : OK en dev, à restreindre en prod.
- **Pas de HTTPS direct** sur le backend : à reverse-proxier (Caddy/nginx) en prod.

### Chiffrement
- **At-rest, pas E2E.** Choix fait pour garder fonctionnels :
  - messages planifiés (le serveur doit pouvoir les délivrer en différé sans clé du destinataire)
  - une future recherche full-text Postgres
  - les notifications avec aperçu du contenu
- **Bodies texte ET fichiers chiffrés** at-rest sur disque (AES-256-GCM, même clé serveur). Les blobs de PJ antérieurs au rollout restent en clair (`Attachment.encrypted=false`).
- **Clé symétrique serveur** via `MESSAGE_ENCRYPTION_KEY` (32 octets hex). Valeur dev par défaut + warning logué.
- **AES-256-GCM** avec IV aléatoire 12 octets par message, format `enc1:<base64(iv||tag||ct)>` (le prefix permet le fallback plaintext pour les anciens messages).

### Persistence
- **`prisma db push` au démarrage**, pas de migrations versionnées. Optimisé MVP. Passer à `migrate deploy` + dossier `prisma/migrations/` en prod.
- **Port Postgres host = 5433** (le 5432 du host était déjà occupé localement).

### Real-time
- **Socket.IO** plutôt que WebSocket pur : fallback long-polling, ack natif, rooms gérées.
- **Auto-subscribe à la création d'un channel** côté serveur (`socketsJoin`) → pas besoin de refresh côté destinataire d'un nouveau DM.
- **Dispatcher de messages planifiés en polling 10 s**, pas de cron/queue : assez précis pour du chat, zéro infra additionnelle.
- **`createdAt` réécrit avec `scheduledAt` à la livraison** : l'heure affichée d'un message planifié est celle prévue par l'auteur, pas celle où il a appuyé sur *Planifier*.

### Notifications
- **Toast in-app TOUJOURS, toast système UNIQUEMENT si la fenêtre n'a pas le focus** : évite le double prompt.
- **Tauri natif + fallback API `Notification` du navigateur** dans le même module ([web/src/desktop.js](web/src/desktop.js)).
- **Pas de Push API** (nécessiterait service worker + VAPID + push service) : couvert par Tauri qui reste vivant via la tray.

### Pièces jointes
- **Max 25 Mo par fichier** (multer).
- **Stockage disque local** (volume Docker `uploads-data`) plutôt que S3 : zéro dépendance externe. À migrer si on veut du multi-instance.
- **Filename UTF-8 explicite** : multer décode en latin1 par défaut, on reconvertit côté serveur pour préserver accents/apostrophes.
- **Paste support** (Cmd/Ctrl+V) en plus du picker : indispensable pour les captures d'écran.

### Desktop / distribution
- **Close = hide to tray** : l'app continue de tourner et de recevoir les messages.
- **Pas de signature de code** : SmartScreen va râler à la première exécution. À fixer avec un certificat de signature si distribution publique.
- **Cross-compile Linux → Windows GNU** via `mingw-w64` + `nsis` : produit du `.exe` NSIS, **pas de `.msi`** (WiX = Windows only). Pour le MSI, builder sur Windows ou via CI `windows-latest`.
- **`VITE_API_URL` baked à la build** côté web et Tauri : le bundle pointe sur une URL fixe, à rebuilder si l'IP du serveur change. Compose lit la variable d'env, défaut `http://172.16.2.192:4000` (à adapter).
- **Pas d'auto-start au boot** dans le bundle actuel : ajouter `tauri-plugin-autostart` plus tard si voulu.
- **Installeur pré-buildé committé** dans [dist/](dist/) : pratique pour un MVP, à remplacer par une release GitHub si le projet grossit.

### Mobile (Expo)
- **Android d'abord** mais le même codebase couvre déjà iOS — il manque juste un build/distrib iOS.

## Pistes pour la suite

État d'avancement détaillé dans [PROGRESS.md](PROGRESS.md). Ce qui reste, classé
par thème :

### Sécurité & production
- **HTTPS** (reverse proxy Caddy/Traefik) — bloquant pour la publication iOS
  App Store (`NSAllowsArbitraryLoads` est toléré en dev, refusé en review).
- **Refresh tokens** côté serveur, à la place du JWT 30j non révoquable.
- **2FA / MFA** pour les comptes admin/owner.
- **CORS strict** (`*` aujourd'hui).
- **Vraies migrations versionnées Prisma** (`prisma migrate` plutôt que
  `db push` au démarrage) — indispensable dès qu'on a de la vraie donnée.
- **Audit log** des actions admin (qui a désactivé qui, transferts de
  propriété, promotions / révocations).

### Mobile
- **Build iOS standalone** (`eas build --platform ios` ou local Xcode) et
  publication App Store. Le code est prêt (`app.json` ATS + `ios.deploymentTarget`).
- **Envoi de pièces jointes** depuis mobile (l'affichage marche déjà, il
  manque le picker natif).
- **Vraie clé de signature Android** (à la place de la clé debug actuelle)
  pour distribuer sur Play Store.
- **Push réelles** : projectId Expo + FCM (`google-services.json` + APNs côté
  iOS). Le gating serveur est déjà en place.

### Desktop
- **Auto-start au boot** Windows via [`tauri-plugin-autostart`](https://v2.tauri.app/plugin/autostart/).
- **Badges non-lus** sur l'icône tray.
- **Signature de code** Windows (Authenticode) pour éviter le warning SmartScreen
  à la première installation.
- **Builds macOS / Linux** (le code Tauri est cross-platform, juste à câbler
  les bundles).

### Fonctionnalités
- **E2E (chiffrement bout-en-bout) pour les DM** — empêcherait la recherche
  full-text et la planification de messages, donc à exclure sur ces canaux.
- **Recherche full-text Postgres** (incompatible avec l'E2E ci-dessus, à
  arbitrer).
- **Nettoyage des fichiers orphelins** sur disque (la suppression d'un message
  avec PJ supprime la ligne `Attachment` mais laisse le blob).
- **Pagination du panel d'administration** au-delà de quelques centaines de
  comptes (le `GET /auth/users` ramène tout pour l'instant).
