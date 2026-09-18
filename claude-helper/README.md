# claude-helper — les experts Claude de MurgaChat

Le cerveau de la section **CLAUDE** de MurgaChat : un service Node sur la VM
`claude-help` (`172.16.1.252`) qui pilote des agents Claude (Agent SDK, modèle
Opus 5), **un par expert**, chacun confiné dans son propre workspace avec un accès
**strictement lecture seule** au système qu'il observe :

| Expert (clé) | Application | Ce qu'il observe | Workspace sur la VM |
|---|---|---|---|
| `supervision` | SUPERVISION (Symfony + api_robot + Modbus) | `claude@172.16.1.182` (docker RO), MariaDB `db_supervision` :3310 | `/home/murgat/claude-helper` |
| `management` | Murgat Management — la **refonte** (`clean_v3`), stack de **test** | `claude@172.16.1.203` (docker RO, logs, git), MySQL 8.4 :3307, HTTPS :443 | `/home/murgat/claude-management` |

```
MurgaChat (.30) ── POST /turn {expert, conversationKey, message} ──▶ ce service (.252:7070)
      ◀── POST /claude/callback (Bearer CALLBACK_TOKEN) ── réponse asynchrone
                        agent (cwd = workspace de l'expert)
                        ├─ CLAUDE.md            connaissance permanente de l'expert
                        ├─ .claude/settings.json permissions (deny d'abord)
                        ├─ mirror/              code miroité (tar-over-ssh, 30 min, secrets exclus)
                        ├─ docs/                procédures de l'équipe (lecture seule)
                        ├─ notes/               carnet de l'expert (git, seul dossier inscriptible)
                        ├─ bin/db               SELECT-only sur la base observée
                        ├─ bin/http             (management) sonde HTTPS de la stack de test
                        └─ ssh claude@<hôte>    compte lecture seule (sudo docker ps/logs/… seulement)
```

Côté chat, chaque utilisateur a **un canal par expert** (`Channel.kind="claude"`,
`Channel.expert` = la clé) ; la liste des experts ouverts vient de `CLAUDE_EXPERTS`
(registre `server/src/experts.ts`). Le helper résout la clé en workspace :
`supervision` → `WORKSPACE`, toute autre clé → `WORKSPACE_<CLÉ EN MAJUSCULES>`
(`src/experts.ts`). Une clé sans workspace = `400 unknown_expert`, jamais un repli
sur un autre expert. Un seul service, une seule file : au plus deux tours en parallèle
tous experts confondus (3,7 Gio de RAM, chaque tour est un process Claude Code).

Le même service porte aussi le **relais du support in-app** du chat (bouton
« Signaler un bug ») : le serveur lui confie chaque tour de triage, exécuté via
le SDK sur l'abonnement — un jeton d'abonnement passé directement à l'API
Messages est throttlé par politique (429 sans en-têtes de quota), le SDK est le
seul chemin qui marche. Voir `src/support.ts`.

Les dossiers sur la VM, volontairement séparés :

- `/home/murgat/claude-helper` — le **workspace de l'expert supervision**
  (installé depuis `runtime/supervision/`).
- `/home/murgat/claude-management` — le **workspace de l'expert Murgat
  Management** (installé depuis `runtime/management/`). Chaque workspace interdit
  la lecture de l'autre.
- `/home/murgat/claude-helper-svc` — le **service** (ce dossier src/ + .env +
  state/). Les agents n'ont pas le droit d'y lire (règle deny) : les secrets du
  pont y vivent.
- `/home/murgat/claude-support` — workspace **vide** des tours de triage du
  support (`settingSources: []`) : ils ne voient ni CLAUDE.md ni permissions, et
  n'ont aucun outil de fichier ou de shell.

## Provisioning

### Commun (fait une fois)

1. Paquets (root) : `curl git rsync mariadb-client` + Node ≥ 24 (NodeSource),
   puis `cp deploy/* /etc/systemd/system/` et `systemctl daemon-reload`.
2. Service : rsync de ce dossier (src/, package*.json, README.md) vers
   `~/claude-helper-svc`, `npm ci`, créer `.env` (chmod 600) :

   ```
   CLAUDE_CODE_OAUTH_TOKEN=…   # jeton `claude setup-token` (abonnement) — ou ANTHROPIC_API_KEY
   HELPER_TOKEN=…              # = CLAUDE_HELPER_TOKEN côté MurgaChat
   CALLBACK_URL=http://172.16.1.30:4000/claude/callback
   CALLBACK_TOKEN=…            # = CLAUDE_CALLBACK_TOKEN côté MurgaChat
   PORT=7070
   WORKSPACE=/home/murgat/claude-helper                 # expert supervision
   WORKSPACE_MANAGEMENT=/home/murgat/claude-management  # expert management
   ```

3. `systemctl enable --now claude-helper`.

Côté MurgaChat : renseigner `CLAUDE_HELPER_URL` / `CLAUDE_HELPER_TOKEN` /
`CLAUDE_CALLBACK_TOKEN` et `CLAUDE_EXPERTS=supervision,management` (voir
`.env.example` à la racine), et `SUPPORT_RELAY_URL` (même URL) pour que le support
in-app passe par le relais.

### Expert supervision (`runtime/supervision/`)

1. Workspace : `~/claude-helper/{notes,mirror,bin,.claude,docs}`, copier
   `CLAUDE.md` → `~/claude-helper/CLAUDE.md`, `settings.json` →
   `~/claude-helper/.claude/settings.json`, `bin/*` → `~/claude-helper/bin/`,
   `git init ~/claude-helper/notes`.
2. Accès lecture seule : clé ed25519 dédiée `murgat@.252 → claude@.182`
   (options `no-port-forwarding,no-agent-forwarding,no-X11-forwarding` dans
   authorized_keys), sudo `docker ps/logs/stats/inspect/images/top/port/info/
   version/system df` en NOPASSWD, `git config --global --add safe.directory
   /home/murgat/supervision` côté claude@.182, utilisateur MariaDB `claude_ro`
   SELECT-only + `~/.my.cnf` (chmod 600) côté murgat@.252.
3. `systemctl enable --now claude-helper-mirror.timer`.

### Expert Murgat Management (`runtime/management/`, posé le 2026-09-18)

Sur **`172.16.1.203`** (la stack de test de la refonte, déployée par la CI) :

1. Compte `claude` (shell bash, groupe `adm`), `~/.ssh/authorized_keys` = la **même**
   clé publique de `murgat@.252` que pour la supervision, avec les options
   `no-port-forwarding,no-agent-forwarding,no-X11-forwarding`.
2. `/etc/sudoers.d/claude-ro` : `docker ps/logs/stats/inspect/images/top/port/info/
   version/system df/compose ls` + `/usr/local/bin/mm-keycloak-log` (script sans
   argument : `tail -n 400` de `keycloak.log`, fichier root 600) en NOPASSWD.
   **Pas** de `docker exec` (= root dans le conteneur), pas d'ajout au groupe docker.
3. ACL : `setfacl -m u:claude:x /home/murgat` (traversée seule), puis
   `setfacl -R -m u:claude:rX` + `-d` (défaut pour les nouveaux fichiers) sur
   `/home/murgat/murgat_management`. Retirés explicitement (`u:claude:---`) : `.env`,
   `data/symfony/.env.local`, `data/react/.env.local`,
   `data/symfony/config/gmail/google-sa.json`, `conf/caddy/certs/` (clé de l'AC),
   `cmd/dumps/dumped/` (dumps SQL), `.claude/worktrees/`. `git config --global --add
   safe.directory '*'` pour `claude` (le dépôt appartient à `murgat`).
4. MySQL 8.4 (`docker exec -i database mysql`) : `claude_ro@172.16.1.252` avec `SELECT,
   SHOW VIEW` sur `murgat_management`, `commercial`, `modules_maintenances`, `archivage`,
   `donnees_generales`, `reclamations`, + `PROCESS` (SHOW PROCESSLIST). Le port 3307 est
   publié sur toutes les interfaces. ⚠️ Si le volume MySQL est recréé (reset complet de
   la stack), l'utilisateur disparaît avec lui : à recréer.

Sur la VM `.252` :

5. Workspace : `~/claude-management/{notes,mirror,bin,.claude,docs}`, copier
   `CLAUDE.md`, `settings.json` → `.claude/settings.json`, `bin/*` (chmod +x),
   `git init ~/claude-management/notes`. Identifiants MySQL dans
   `~/.my-management.cnf` (chmod 600, `[client] user=claude_ro password=…`) ; `bin/db`
   passe `--ssl-verify-server-cert=0` (certificat auto-généré de MySQL, liaison chiffrée
   quand même). Ajouter `172.16.1.203` à `~/.ssh/known_hosts` (`ssh-keyscan`).
6. `.env` du service : `WORKSPACE_MANAGEMENT=/home/murgat/claude-management`, puis
   `systemctl restart claude-helper` (`GET /health` liste les experts servis).
7. `systemctl enable --now claude-management-mirror.timer` (miroir toutes les 30 min +
   `mirror/DEPLOYED.txt` = SHA servi et derniers commits du checkout).

## Contrat HTTP

- `POST /turn` — `{conversationKey, expert?, message, author?{displayName}}` → `202`
  et le tour part en tâche de fond ; `expert` absent = `supervision` (serveurs de
  chat antérieurs) ; `401` / `400 invalid_payload` / `400 unknown_expert` (pas de
  `WORKSPACE_*` pour cette clé) / `429 queue_full` (buffer > 20 messages sur une
  conversation).
- Réponse → `POST {CALLBACK_URL}` : `{channelId, ok, reply?}` ou
  `{channelId, ok:false, error}` ; retries 30 s / 2 min / 10 min puis
  dead-letter dans `state/deadletter/` (rejouable à la main avec curl).
- `GET /health` → `{ok, pending, experts}`.
- `POST /support-turn` — relais du triage (**synchrone**, quelques secondes) :
  `{system, messages:[{role:"user"|"assistant", content}]}` (Bearer
  `HELPER_TOKEN`) → `{reply, finalize}` où `finalize` est l'entrée de l'outil
  `submit_ticket` (`title, body, severity?, domain?`) ou `null`. `401` / `400
  invalid_payload` / `429 busy` (2 tours en parallèle max) / `502 turn_failed`.
  Sans état : le serveur renvoie tout le transcript à chaque tour.

## Confinement des agents

Les permissions vivent dans `runtime/<expert>/settings.json` (deny évalué d'abord) :
écriture limitée à `notes/`, Bash limité à quelques préfixes (`ssh claude@<hôte>`,
`bin/db`, `bin/http`, `bin/sync-mirror`), lecture des `.env*`/`.my*.cnf`/du service/de
l'autre workspace interdite, Web coupé. La vraie frontière reste, sur chaque machine
observée, le compte `claude` (sudo docker RO uniquement, pas de `docker exec`) et
l'utilisateur SQL SELECT-only. Limites connues : un agent **peut lire** les configs
non secrètes de l'application via ssh (règle CLAUDE.md : jamais recopier un secret
dans le chat), et la section CLAUDE est ouverte à toute l'équipe. L'expert
management ne voit que la stack de **test** : il n'a aucun accès à la production
réelle de Murgat Management, et son CLAUDE.md lui impose de le dire.
