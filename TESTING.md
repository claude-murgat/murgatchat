# Tests — suite anti-régression murgatchat

Objectif : vérifier que toutes les fonctionnalités définies (voir [PROGRESS.md](PROGRESS.md))
fonctionnent et ne régressent pas d'une version à l'autre. La couverture est
organisée en quatre couches de test, par ordre de valeur (plus des garde-fous
**qualité / sécurité** en CI — lint, SAST, DAST — décrits en [fin de page](#ci-github-actions)) :

| Couche | Outil | Ce qu'elle protège | Vérifiée |
| --- | --- | --- | --- |
| **Backend** (priorité 1) | Vitest + supertest + socket.io-client | API HTTP, temps réel Socket.IO, crypto, DnD, gating push, invitations + reset password + profil + propriétaire/panel admin — **la source de vérité** pour web/desktop/mobile | ✅ 270 tests |
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
npx prisma generate # Prisma 7 : plus de postinstall, la génération est explicite
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
- L'appel Expo push est mocké (`vi.stubGlobal("fetch", …)`) et Web Push l'est au
  niveau de `web-push` (`vi.spyOn(webpush, "sendNotification")`) : aucun appel
  réseau, gating déterministe. Un message concernant un membre est poussé vers
  tous ses appareils (plus de détection de présence) ; seuls DnD, le niveau du
  salon (`none`/`mentions`), un compte désactivé et l'exclusion de l'auteur
  suppriment le push.

### Couverture
- `test/unit/` — crypto (round-trip `enc1:`, fallback clair, déchiffrement KO),
  `isUserDnd` (fenêtre ponctuelle + plage quotidienne, passage de minuit).
- `test/http/` — auth (register **sur invitation** + bootstrap 1er compte admin,
  login/me/dnd/dnd-schedule/push-token), **invitations** (admin invite → e-mail capturé
  dans Mailpit avec le code → register via token ; non-admin refusé ; mismatch/expiré/utilisé),
  **password-reset** (forgot → mail capturé → validation token → reset → auto-login ; pas
  d'énumération de comptes ; expiré / déjà utilisé ; nouvelle demande invalide les
  précédentes), **profile** (`PATCH /auth/me` : displayName + changement mdp avec ou sans
  mot de passe actuel, rejet 401/403/400), **admin-panel** (rôles bootstrap = owner+admin ;
  `GET /auth/users` admin-only ; `PATCH /auth/users/:id` avec permissions par champ : owner
  seul pour `isAdmin`, owner-pour-admin pour `status=disabled` ; auto-disable/transfer interdits ;
  `POST /auth/transfer-ownership` ; soft delete : login refusé + JWT invalidé via re-check
  du status (`authenticate`, partagé par `requireAuth`, la poignée de main Socket.IO et
  `GET /uploads/:id?token=`) ; sockets déjà ouvertes coupées (`session:revoked`), plus de
  push ni de messages planifiés ; **suppression définitive** (`DELETE /auth/users/:id`,
  compte désactivé seulement : purge messages/PJ/DM, réponses des autres conservées,
  rapports de bug gardés, bot protégé) ; `ensureOwner()` self-heal des bases pré-0.4.0), channels (create/list/public/join/dm/membres/leave +
  règles du salon par défaut ; membre retiré d'un salon privé : plus d'édition/suppression de ses
  messages, planifiés abandonnés), messages (edit/delete/thread ; **« Supprimer pour moi »** :
  masqué pour l'appelant seul — historique, citation des réponses, non-lus, recherche —,
  idempotent, réservé aux membres), planifiés (list/patch/delete +
  dispatch, auteur désactivé ou plus membre), pièces jointes (réservées aux membres du salon, auteur
  compris), réactions (toggle/agrégation), non-lus.
- `test/socket/` — accès aux salons privés (`channel:join` et `typing` refusés à un non-membre,
  membre retiré sorti de la room, admin rétrogradé sorti du salon du pipeline), `message:new`/`updated`/`deleted`, `message:hidden` (aux seuls appareils de celui qui masque), `thread:reply`,
  `reaction:update`, `presence`, `typing`, `channel:read`, événements de membres,
  handshake `auth.platform`, et les **notifications push** (`notifyMembers` :
  membre non-DND → push vers tous ses appareils, même connecté/actif ; natif +
  web poussés ensemble ; DND → rien ; `notifyLevel=none`/`mentions` → suppression ;
  compte désactivé → rien ; auteur exclu ; purge `DeviceNotRegistered` ;
  **message très long** → extrait tronqué, Web Push chiffré et message Expo sous 4 Ko ;
  **jeton de lecture** : chaque destinataire reçoit le sien, `/auth/web-push/read-state`
  le dit non lu à l'envoi puis lu dès que le destinataire lit ailleurs, jeton falsifié → null).
- `test/unit/pushReadToken.test.js` — jeton de lecture des Web Push : signé/vérifié,
  contenu ou signature altérés et entrées mal formées refusés.
- `test/unit/pushTriage.test.js` — tri d'un push à son arrivée dans le service worker
  (`shared/pushTriage.ts`) : message lu ailleurs non affiché, notifications lues fermées,
  silence quand il faut tout de même montrer, et l'invariant « jamais aucune notification
  visible » vérifié sur toutes les combinaisons.
- `test/unit/webpush.test.js` — en-têtes réellement produits par web-push
  (`Urgency: high`, `TTL: 86400`, pas de `Topic`, VAPID, timeout) et envois en
  parallèle (un service push lent ne retient pas les autres abonnés).
- `test/unit/pushExcerpt.test.js` — extrait porté par les pushs : 500 caractères
  « … » compris, 2 000 octets JSON au plus, paire de substitution jamais coupée.

> Note : le handler de connexion Socket.IO enregistre ses écouteurs après un
> `await` ; un client qui émet immédiatement après `connect` peut perdre des
> événements. Les tests attendent que le serveur ait joint la socket à la room du
> salon (`waitInRoom`) avant d'émettre, ce qui est déterministe.

---

## 2. E2E Web (Playwright)

Parcours complet dans un vrai navigateur : inscription → création d'un salon privé
(pour ne pas polluer « Général ») → envoi / édition / suppression d'un message →
réponse dans un fil → persistance après rechargement → déconnexion.
`delete-for-me.spec.js` : « Supprimer pour moi » sur le message d'un autre — masqué de
son côté (même après rechargement), toujours visible de l'auteur.
`push-read-state.spec.js` : injecte de vrais évènements `push` dans le service worker
(protocole DevTools, `ServiceWorker.deliverPushMessage`) avec des jetons de lecture signés
comme le serveur : un message déjà lu ailleurs n'est pas affiché, les notifications lues sont
fermées, l'app ferme celles d'une conversation qu'on ouvre. Il tourne sur le **Chromium
complet** (`channel: "chromium"`) : `chromium-headless-shell`, le headless par défaut de
Playwright, refuse la permission de notification.

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
    `/channels/public`, réactions, niveau de notif par salon, `/auth/dnd`) avec think-time.
- **Montée 1 min → plateau 8 min 30 → descente 30 s** (≈ 10 min).
- `setup()` repart d'une base vierge (`POST /test/reset`, gated `E2E_TEST_MODE`),
  bootstrap un admin, puis crée les 150 comptes **via le flux d'invitation** (inscription
  invitation-only — l'admin émet une invitation par compte, puis register avec le token) +
  des salons partagés (chaque envoi fait donc un vrai fan-out vers les membres). Aucun appel
  Expo réel (les comptes n'ont pas de push-token → `notifyMembers` n'émet pas de push).

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

[.github/workflows/tests.yml](.github/workflows/tests.yml) tourne sur **chaque pull request**
(et est appelé par `release.yml` via `workflow_call`, comme gate avant publication ; il n'y a
**pas** de trigger `push` sur `main` — la PR a déjà tout validé). **Cinq jobs, tous bloquants** :

- **backend** — service Postgres + `npm ci` + `prisma generate` + `npm test`
  (passe `TEST_DATABASE_URL`, donc pas de Docker-in-Docker).
- **e2e** — monte `docker-compose.e2e.yml`, installe Playwright + Chromium,
  attend la santé du stack, lance le parcours, puis démonte (artefact = rapport
  Playwright en cas d'échec).
- **lint** — ESLint 9 (flat config) sur `web/` et `server/` (`npm run lint` dans chaque
  package). Échoue sur toute **erreur** ; `react-hooks/exhaustive-deps` reste en warning
  advisory. ⚠ En local, lancer `npx prisma generate` avant `npm test` — après une
  installation comme après un changement de schéma : depuis Prisma 7 le paquet
  `@prisma/client` n'a plus de hook `postinstall`, et le `globalSetup` fait un simple
  `db push` qui ne génère rien.
- **sast** — [Semgrep](https://semgrep.dev) (rulesets `javascript`, `react`, `nodejs`,
  `expressjs`, `secrets`, `owasp-top-ten`). SARIF publié en artefact ; **échoue sur les
  findings de sévérité ERROR**.
- **dast** — [OWASP ZAP](https://www.zaproxy.org) baseline (passif) contre le même stack e2e,
  lancé après montée du `docker-compose.e2e.yml`. Alertes triées/acceptées dans
  [.zap/rules.tsv](.zap/rules.tsv) (format `id⇥action⇥nom`) ; **échoue sur toute alerte
  WARN/FAIL non triée** ; rapport HTML/MD/JSON en artefact.

Les actions GitHub sont **épinglées au SHA de commit** et maintenues à jour par Dependabot
([.github/dependabot.yml](.github/dependabot.yml) — hebdo, cooldown de 7 j).

> **Durcissement associé** (côté image, pas côté test — validé indirectement par e2e/dast) :
> conteneurs **non-root** (serveur = user `node`, web = `nginx-unprivileged` sur `:8080`) +
> en-têtes de sécurité (Helmet côté API, en-têtes nginx côté web). Voir le
> [README](README.md#auth--sécurité) et la note de déploiement (chown des volumes).
