# claude-helper — l'expert Claude « supervision »

Le cerveau de la section **CLAUDE** de MurgaChat : un service Node sur la VM
`claude-help` (`172.16.1.252`) qui pilote un agent Claude (Agent SDK, modèle
Opus 5) expert de l'application SUPERVISION, avec un accès **strictement
lecture seule** au serveur supervision (`claude@172.16.1.182`) et à sa base.

```
MurgaChat (.30) ── POST /turn (Bearer HELPER_TOKEN) ──▶ ce service (.252:7070)
      ◀── POST /claude/callback (Bearer CALLBACK_TOKEN) ── réponse asynchrone
                        agent (cwd /home/murgat/claude-helper)
                        ├─ mirror/supervision/  code miroité (rsync 30 min, .env exclus)
                        ├─ docs/                procédures de l'équipe (lecture seule)
                        ├─ notes/               carnet de l'expert (git, seul dossier inscriptible)
                        ├─ bin/db               SELECT-only sur MariaDB .182:3310
                        └─ ssh claude@.182      docker RO (sudo whitelist), journalctl, /var/log
```

Deux dossiers sur la VM, volontairement séparés :

- `/home/murgat/claude-helper` — le **workspace de l'agent** (CLAUDE.md,
  `.claude/settings.json`, docs/, notes/, mirror/, bin/). Contenu installé
  depuis `runtime/`.
- `/home/murgat/claude-helper-svc` — le **service** (ce dossier src/ + .env +
  state/). L'agent n'a pas le droit d'y lire (règle deny) : les secrets du pont
  y vivent.

## Provisioning (résumé — détail dans la PR d'origine)

1. Paquets (root) : `curl git rsync mariadb-client` + Node ≥ 24 (NodeSource),
   puis `cp deploy/* /etc/systemd/system/`.
2. Workspace : créer `~/claude-helper/{notes,mirror,bin,.claude,docs}`, copier
   `runtime/CLAUDE.md` → `~/claude-helper/CLAUDE.md`, `runtime/settings.json` →
   `~/claude-helper/.claude/settings.json`, `runtime/bin/*` → `~/claude-helper/bin/`,
   `git init ~/claude-helper/notes`.
3. Service : rsync de ce dossier vers `~/claude-helper-svc`, `npm ci`, créer
   `.env` (chmod 600) :

   ```
   ANTHROPIC_API_KEY=…       # la clé qui paie les tours
   HELPER_TOKEN=…            # = CLAUDE_HELPER_TOKEN côté MurgaChat
   CALLBACK_URL=http://172.16.1.30:4000/claude/callback
   CALLBACK_TOKEN=…          # = CLAUDE_CALLBACK_TOKEN côté MurgaChat
   PORT=7070
   WORKSPACE=/home/murgat/claude-helper
   ```

4. Accès lecture seule : clé ed25519 dédiée `murgat@.252 → claude@.182`
   (options `no-port-forwarding,no-agent-forwarding,no-X11-forwarding` dans
   authorized_keys), `git config --global --add safe.directory
   /home/murgat/supervision` côté claude@.182, utilisateur MariaDB `claude_ro`
   SELECT-only + `~/.my.cnf` (chmod 600) côté murgat@.252.
5. `systemctl daemon-reload && systemctl enable --now claude-helper
   claude-helper-mirror.timer`.

Côté MurgaChat : renseigner `CLAUDE_HELPER_URL` / `CLAUDE_HELPER_TOKEN` /
`CLAUDE_CALLBACK_TOKEN` (voir `.env.example` à la racine).

## Contrat HTTP

- `POST /turn` — `{conversationKey, message, author?{displayName}}` → `202` et
  le tour part en tâche de fond ; `401` / `400 invalid_payload` /
  `429 queue_full` (buffer > 20 messages sur une conversation).
- Réponse → `POST {CALLBACK_URL}` : `{channelId, ok, reply?}` ou
  `{channelId, ok:false, error}` ; retries 30 s / 2 min / 10 min puis
  dead-letter dans `state/deadletter/` (rejouable à la main avec curl).
- `GET /health` → `{ok, pending}`.

## Confinement de l'agent

Les permissions vivent dans `runtime/settings.json` (deny évalué d'abord) :
écriture limitée à `notes/`, Bash limité à trois préfixes (`ssh claude@…`,
`bin/db`, `bin/sync-mirror`), lecture des `.env*`/`.my.cnf`/du service
interdite, Web coupé. La vraie frontière côté supervision reste le compte
`claude@.182` (sudo docker RO uniquement) et l'utilisateur SQL SELECT-only.
Deux limites connues à ne pas oublier : l'agent **peut lire** les configs de la
supervision via ssh (règle CLAUDE.md : jamais recopier un secret dans le chat),
et la section CLAUDE est ouverte à toute l'équipe.
