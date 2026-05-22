# Tests — suite anti-régression murgatchat

Objectif : vérifier que toutes les fonctionnalités définies (voir [PROGRESS.md](PROGRESS.md))
fonctionnent et ne régressent pas d'une version à l'autre. La couverture est
organisée en trois couches, par ordre de valeur :

| Couche | Outil | Ce qu'elle protège | Vérifiée |
| --- | --- | --- | --- |
| **Backend** (priorité 1) | Vitest + supertest + socket.io-client | API HTTP, temps réel Socket.IO, crypto, DnD, gating push — **la source de vérité** pour web/desktop/mobile | ✅ 70 tests |
| **E2E Web** (priorité 2) | Playwright | Câblage de l'UI web (auth, envoi, édition, suppression, threads, persistance) | Prête à lancer |
| **Mobile** (priorité 3) | `expo export` + smoke APK | Le bundle RN se compile ; l'app se lance | Documentée |

La base de dev (`db-data`, port hôte **5433**) n'est **jamais** touchée : le backend
utilise un Postgres jetable sur le port 5434, l'E2E un stack isolé sur 5435/4001/5174.

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
- **`vitest.config.js`** injecte `DATABASE_URL`, `JWT_SECRET`,
  `MESSAGE_ENCRYPTION_KEY` (clé de test connue) et `UPLOAD_DIR` dans
  `process.env` de chaque worker, avant l'import de `src/db.js` / `src/crypto.js`.
- **`test/setup.js`** tronque toutes les tables avant chaque test (isolation).
  Les fichiers tournent en série (`fileParallelism: false`) pour partager sans
  risque l'unique base de test.
- L'appel Expo push est mocké (`vi.stubGlobal("fetch", …)`) : aucun appel réseau,
  gating déterministe.

### Couverture
- `test/unit/` — crypto (round-trip `enc1:`, fallback clair, déchiffrement KO),
  `isUserDnd` (fenêtre ponctuelle + plage quotidienne, passage de minuit).
- `test/http/` — auth (register/login/me/dnd/dnd-schedule/push-token), channels
  (create/list/public/join/dm/membres/leave + règles du salon par défaut),
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

## CI (GitHub Actions)

[.github/workflows/tests.yml](.github/workflows/tests.yml) lance sur chaque PR et push `main` :
- **backend** — service Postgres + `npm ci` + `prisma generate` + `npm test`
  (passe `TEST_DATABASE_URL`, donc pas de Docker-in-Docker).
- **e2e** — monte `docker-compose.e2e.yml`, installe Playwright + Chromium,
  attend la santé du stack, lance le parcours, puis démonte (artefact = rapport
  Playwright en cas d'échec).
