# Chat — un clone Slack-like

Copie graphiquement inspirée de Slack avec :

- **Backend** Node.js (Express + Socket.IO) + Prisma + PostgreSQL
- **Web** React + Vite + Tailwind (thème aubergine de Slack)
- **Desktop** Tauri 2 (Windows / macOS / Linux) — réutilise le React, ajoute system tray + notifications natives
- **Mobile** React Native via Expo (Android d'abord, iOS prêt à activer)
- **Docker** `docker-compose` pour DB + backend + web
- **Fonctionnalités** : auth JWT, salons publics/privés, messages directs, *Ne pas déranger*, **messages planifiés** (créer / modifier / supprimer), **pièces jointes** (drag-drop, picker, collage Cmd/Ctrl+V), **chiffrement at-rest** des bodies (AES-256-GCM), notifications temps réel, **notifications système** (toast Windows/macOS via Tauri ou API browser)

```
.
├── docker-compose.yml
├── dist/           # binaires prêts à distribuer (installeur Windows .exe)
├── server/         # API + WebSocket + Prisma
├── web/            # client React (Slack look)
│   └── src-tauri/  # wrapper desktop (Rust + Tauri 2)
└── mobile/         # app Expo (Android, iOS prêt)
```

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

Sur l'émulateur Android, `http://10.0.2.2:4000` est le hôte (déjà configuré dans `app.json`). Sur un device physique, modifie `extra.API_URL` pour pointer l'IP de ta machine sur le LAN. iOS s'active dès `expo run:ios` sur macOS.

### Desktop (Tauri — Windows / macOS / Linux)

**Installeur Windows pré-buildé** : [dist/Chat_0.1.0_x64-setup.exe](dist/Chat_0.1.0_x64-setup.exe) (1,4 Mo, NSIS, non signé — SmartScreen va râler une fois) — pointe sur `http://172.16.2.192:4000` par défaut. Aussi disponible : [dist/Chat-portable.exe](dist/Chat-portable.exe) (3,3 Mo, autonome, sans installation).

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

**Builder le bundle Windows :**

```bash
npm run tauri:build        # produit src-tauri/target/release/bundle/{msi,nsis}/Chat_*.msi|.exe
```

**Cross-compile depuis Linux** (utilisé pour produire l'installeur dans [dist/](dist/)) :

```bash
sudo apt install -y mingw-w64 nsis libayatana-appindicator3-dev
rustup target add x86_64-pc-windows-gnu

cd web
VITE_API_URL=http://<ton-ip-lan>:4000 \
  npx tauri build --target x86_64-pc-windows-gnu
# → web/src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Chat_<v>_x64-setup.exe
```

Le `.msi` n'est pas produit depuis Linux (WiX = Windows only). Pour avoir le MSI, build sur Windows ou via un runner CI `windows-latest`.

**Récupérer l'installeur depuis Windows** (si le repo tourne sur une autre machine du LAN) :

```powershell
scp murgat@<ip-machine-build>:/path/to/Chat/dist/Chat_0.1.0_x64-setup.exe .
```

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
- Téléchargement `GET /uploads/:id?token=<jwt>` — auth + check d'appartenance au salon du message lié (ou être l'uploader si pas encore attaché).
- UI Composer : bouton `📎 Fichier`, picker multi-sélection, **collage Cmd/Ctrl+V** (capture d'écran ou n'importe quel fichier dans le presse-papier).
- Rendu : miniature pour les images (`image/*`), pavé icône + nom + taille pour les autres types.
- Encodage des noms : multer décode en latin1 par défaut → reconverti côté serveur en UTF-8 pour préserver accents/apostrophes.

**Décision : le contenu des fichiers n'est pas chiffré sur disque.** Seuls les bodies texte le sont. Pour chiffrer les blobs, il faudrait stream-encrypt à l'upload et stream-decrypt au download — à faire si on stocke des PJ sensibles.

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
| GET     | `/uploads/:id?token=<jwt>`         | télécharger une PJ                           |

## Événements Socket.IO

Côté client → serveur : `channel:join`, `channel:read`, `message:send` (`{ channelId, body?, attachmentIds?, scheduledAt? }`).
Côté serveur → client : `message:new`, `channel:created`, `notification`.

## Pistes pour la suite

- chiffrement at-rest des **fichiers** (stream-encrypt en plus du body)
- E2E pour les DM (avec planification désactivée pour ces canaux)
- édition des messages déjà envoyés, suppression, threads, réactions
- présence en ligne, typing indicators
- recherche full-text Postgres (incompatible si on passe en E2E)
- push notifications natives Expo
- iOS : `eas build --platform ios`
- vraies migrations versionnées Prisma pour la prod
- desktop : auto-start au boot via `tauri-plugin-autostart`, badges sur l'icône tray, signature de code Windows pour éviter SmartScreen
