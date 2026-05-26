# Tests — suite anti-régression murgatchat

Objectif : vérifier que toutes les fonctionnalités définies (voir [PROGRESS.md](PROGRESS.md))
fonctionnent et ne régressent pas d'une version à l'autre. La couverture est
organisée en trois couches, par ordre de valeur :

| Couche | Outil | Ce qu'elle protège | Vérifiée |
| --- | --- | --- | --- |
| **Backend** (priorité 1) | Vitest + supertest + socket.io-client | API HTTP, temps réel Socket.IO, crypto, DnD, gating push — **la source de vérité** pour web/desktop/mobile | ✅ 70 tests |
| **E2E Web** (priorité 2) | Playwright | Câblage de l'UI web (auth, envoi, édition, suppression, threads, persistance) | ✅ parcours vert |
| **Mobile** (priorité 3) | `expo export` + smoke APK | Le bundle RN se compile ; l'app se lance | Documentée |
| **Charge** (k6) | k6 (HTTP + Socket.IO) | Tenue à 150 utilisateurs simultanés (REST + temps réel) | ✅ script validé (smoke) |

La base de dev (`db-data`, port hôte **5433**) n'est **jamais** touchée : le backend
utilise un Postgres jetable sur le port 5434 ; l'E2E **et** la charge k6 visent le stack
isolé (5435/4001/5174).

---

## 1. Backend (Vitest)

Tests d'intégration qui démarrent le vrai serveur Express/Socket.IO en mémoire
(`createServer()` dans [server/src/index.js](server/src/index.js)) contre un
**Postgres de test jetable**.

### Prérequis
- Node 20+
- Docker (pour le Postgres de test local) — ou un `TEST_DATABASE_URL` fourni.

### Lancer
```bash
cd server
npm install
npm test            # vitest run (tous les tests)
npm run test:watch  # mode watch
npm test -- test/http/auth.test.js   # un fichier
```

### Comment ça marche
- **`test/globalSetup.js`** lève un conteneur `postgres:16-alpine` nommé
  `murgat-test-db` sur le port **5434**, attend `pg_isready`, puis applique le
  schéma (`prisma db push`). Il est supprimé en fin de run.
  - Si `TEST_DATABASE_URL` est défini (ex. en CI), aucun conteneur n'est créé :
    le schéma est poussé sur cette base.
  - Lève aussi **Mailpit** (`murgat-test-mail`, SMTP 1026 / API 8026) pour capturer les
    e-mails d'invitation ; les tests interrogent son API HTTP pour vérifier l'envoi + le code.
- **`vitest.config.js`** injecte `DATABASE_URL`, `JWT_SECRET`, `MESSAGE_ENCRYPTION_KEY`
  (clé de test connue), `UPLOAD_DIR`, et `SMTP_HOST`/`SMTP_PORT`/`APP_URL` (→ Mailpit) dans
  `process.env` de chaque worker, avant l'import de `src/db.js` / `src/crypto.js` / `src/mail.js`.
- **`test/setup.js`** tronque toutes les tables avant chaque test (isolation).
  Les fichiers tournent en série (`fileParallelism: false`) pour partager sans
  risque l'unique base de test.
- L'appel Expo push est mocké (`vi.stubGlobal("fetch", …)`) : aucun appel réseau,
  gating déterministe.

### Couverture
- `test/unit/` — crypto (round-trip `enc1:`, fallback clair, déchiffrement KO),
  `isUserDnd` (fenêtre ponctuelle + plage quotidienne, passage de minuit).
- `test/http/` — auth (register **sur invitation** + bootstrap 1er compte admin,
  login/me/dnd/dnd-schedule/push-token), **invitations** (admin invite → e-mail capturé
  dans Mailpit avec le code → register via token ; non-admin refusé ; mismatch/expiré/utilisé),
  channels (create/list/public/join/dm/membres/leave + règles du salon par défaut),
  messages (edit/delete/thread), planifiés (list/patch/delete + dispatch),
  réactions (toggle/agrégation), non-lus.
- `test/socket/` — `message:new`/`updated`/`deleted`, `thread:reply`,
  `reaction:update`, `presence`, `typing`, `channel:read`, événements de membres,
  handshake `auth.platform`, et le **gating push** (`notifyMembers` : actif → pas
  de push ; absent + token + non-DND → push ; DND → rien ; purge
  `DeviceNotRegistered`).

> Note : le handler de connexion Socket.IO enregistre ses écouteurs après un
> `await` ; un client qui émet immédiatement après `connect` peut perdre cet
> événement. Les tests attendent que le serveur ait joint la socket à la room du
> salon (`waitInRoom`) avant d'émettre, ce qui est déterministe.

---

## 2. E2E Web (Playwright)

Parcours complet dans un vrai navigateur : inscription → création d'un salon privé
(pour ne pas polluer « Général ») → envoi / édition / suppression d'un message →
réponse dans un fil → persistance après rechargement → déconnexion.

### Option recommandée — stack isolé (ne touche pas la base de dev)
```bash
docker compose -f docker-compose.e2e.yml up -d --build      # db 5435, api 4001, web 5174
cd e2e
npm install
npx playwright install chromium
E2E_BASE_URL=http://localhost:5174 npm test
cd ..
docker compose -f docker-compose.e2e.yml down -v            # base éphémère détruite
```

### Option rapide — contre le stack de dev déjà lancé
```bash
cd e2e && npm install && npx playwright install chromium && npm test
# (cible http://localhost:5173 par défaut ; ajoute un utilisateur e2e_* à la base de dev)
```

Rapport HTML : `npm --prefix e2e run report`.

---

## 3. Mobile (smoke)

Vérification que le bundle React Native se compile (Metro) — non bloquée par le
piège « chemin avec espace » (c'est du JS pur, contrairement au build natif Android) :
```bash
cd mobile
npm install
npx expo export --platform android   # ou --platform web ; échoue si le bundle ne compile pas
```
Smoke APK complet (build x86_64 hors chemin à espace, install émulateur `alarm_dev`,
launch + login) : voir la recette dans [PROGRESS.md](PROGRESS.md) et le README.

---

## 4. Charge (k6)

[load/k6/chat-load.js](load/k6/chat-load.js) — test de charge mixte **HTTP + Socket.IO**.

### Profil (par défaut)
- **150 utilisateurs simultanés** au pic, répartis en deux scénarios partageant le
  même timing :
  - **100 « chatters »** : connexions Socket.IO persistantes (handshake `40{auth}`,
    `message:send`, `typing`, `channel:read`, heartbeat `activity`, réponse aux pings).
  - **50 « readers »** : boucles REST (`/auth/me`, `/channels`, `/channels/:id/messages`,
    `/channels/public`, réactions, `/auth/dnd`) avec think-time.
- **Montée 1 min → plateau 8 min 30 → descente 30 s** (≈ 10 min).
- `setup()` enregistre les 150 comptes + des salons partagés (chaque envoi fait donc
  un vrai fan-out vers les membres). Aucun appel Expo réel (les comptes n'ont pas de
  push-token → `notifyMembers` n'émet pas de push).

### Prérequis
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (`winget install k6`,
  `choco install k6`, ou binaire portable).

### Lancer (contre le stack isolé — ne touche pas la base de dev)
```bash
docker compose -f docker-compose.e2e.yml up -d --build      # API sur :4001
k6 run load/k6/chat-load.js                                  # profil complet (~10 min)
docker compose -f docker-compose.e2e.yml down -v
```
Overrides : `-e BASE_URL=http://…`, `-e CHATTERS=120 -e READERS=30`, `-e CHANNELS=20`.

### Validation rapide (smoke, ~35 s, 6 VUs)
```bash
k6 run -e SMOKE=1 load/k6/chat-load.js
```

### Seuils (échec du run si dépassés)
`http_req_failed < 5%`, `http_req_duration p95 < 3 s`, `checks > 90%`,
`ws_connect_success > 95%`.

> Non câblé en CI (un run de ~10 min n'est pas un gate par PR) — à lancer à la demande,
> idéalement avant une montée de version.

## CI (GitHub Actions)

[.github/workflows/tests.yml](.github/workflows/tests.yml) lance sur chaque PR et push `main` :
- **backend** — service Postgres + `npm ci` + `prisma generate` + `npm test`
  (passe `TEST_DATABASE_URL`, donc pas de Docker-in-Docker).
- **e2e** — monte `docker-compose.e2e.yml`, installe Playwright + Chromium,
  attend la santé du stack, lance le parcours, puis démonte (artefact = rapport
  Playwright en cas d'échec).
