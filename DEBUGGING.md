# DEBUGGING — outils d'investigation pour les bugs réseau

Pendant la phase d'alpha-test, certains incidents ne peuvent pas être
reproduits depuis le poste de dev (problèmes de tunnel VPN, MTU, middlebox,
firewall d'entreprise…). Ce document liste des procédures actionnables pour
isoler la cause d'un bug réseau **sans toucher au code applicatif**.

## Symptômes typiques couverts

- `net::ERR_CONNECTION_RESET` côté navigateur sur certaines requêtes (souvent
  les `POST`).
- Inscription / login / envoi de message qui échoue selon le réseau d'origine
  alors que `GET /health` réussit depuis le même client.
- Différence de comportement entre LAN, VPN et lien internet direct.

L'asymétrie « **GET passe, POST reset** » est l'indice numéro 1 : ça pointe
quasi systématiquement vers un problème de réseau (MTU/MSS, inspection
deep-packet, politique VPN) plutôt qu'un bug applicatif.

---

## 1. Vérifier que la requête atteint Node — `DEBUG_HTTP=1`

Le serveur expose un access log opt-in via une variable d'env. Activez-le
**temporairement** sur le serveur incriminé (pas en prod sans rotation des
logs) et demandez à l'utilisateur de retenter l'opération.

```bash
# Au lancement direct (dev) :
DEBUG_HTTP=1 npm --prefix server start

# Via docker-compose : ajoutez l'env au service `server` dans docker-compose.yml
#   environment:
#     DEBUG_HTTP: "1"
# puis :
docker compose up -d server
docker compose logs -f server
```

Chaque requête HTTP qui **arrive jusqu'à Express** est logguée :

```
[http] POST /auth/register body=187o status=200 14ms ip=172.16.4.51
[http] POST /auth/register body=187o status=200 11ms ip=172.16.4.51
```

Interprétation :

- **La ligne apparaît** → la requête a bien atteint Node. Le `ERR_CONNECTION_RESET`
  vient d'**après** la réponse, ou de la fermeture de connexion (probablement
  un middlebox sur le retour). Inspectez avec `tcpdump` côté serveur.
- **Aucune ligne n'apparaît** → la requête meurt **avant** Node. Le serveur
  n'est pas en cause. Continuez avec `tcpdump` sur l'interface d'écoute et
  testez le MTU du tunnel.

> Pensez à **désactiver** `DEBUG_HTTP` après l'enquête : il loggue chaque
> requête, ça bruite les journaux et révèle les patterns de trafic.

---

## 2. Capturer le trafic réseau sur le serveur — `tcpdump`

Sur le serveur, pendant que l'utilisateur retente l'opération qui échoue :

```bash
# Toutes les connexions TCP sur le port 4000, IPs et flags compris :
sudo tcpdump -i any -n 'tcp port 4000' -w /tmp/incident.pcap
# (Ctrl-C après la tentative)

# Décodage rapide en console (sans pcap) :
sudo tcpdump -i any -n -A 'tcp port 4000 and (tcp[tcpflags] & tcp-rst) != 0'
```

Lecture du pcap (Wireshark ou `tcpdump -r /tmp/incident.pcap -n`) :

- **RST émis par le serveur** (source = IP serveur, flags `R`) → le kernel
  serveur a coupé ; cherchez pourquoi (port fermé, conntrack saturé, MTU/MSS
  côté serveur).
- **RST émis depuis l'IP utilisateur ou une IP intermédiaire** → c'est un
  middlebox / firewall / VPN concentrateur qui interrompt. Confirmez en
  comparant les TTL : un middlebox falsifie souvent le TTL.
- **Pas de RST mais la session reste suspendue** → MTU/MSS ; les paquets
  data ne traversent pas mais le 3-way handshake oui.

---

## 3. Mesurer le MTU effectif du tunnel — `ping -f`

Depuis le poste de l'utilisateur (Windows ou Linux), on cherche la plus
grande taille de paquet ICMP qui passe SANS fragmentation. La valeur normale
sur LAN éthernet est 1472 (MTU 1500 - 28 d'en-têtes).

```powershell
# Windows :
ping -f -l 1472 172.16.1.30
ping -f -l 1440 172.16.1.30
ping -f -l 1400 172.16.1.30
# Diminuez par paliers de 50 jusqu'à ne plus avoir
# "Packet needs to be fragmented but DF set."
```

```bash
# Linux/macOS :
ping -M do -s 1472 172.16.1.30
```

Si le tunnel a un **MTU effectif < 1400**, c'est très probablement la cause :
les `POST` HTTP avec un body JSON peuvent dépasser cette limite (préflight
CORS + en-têtes + cookies + body). Les `GET` minuscules passent.

### Mitigation

- **MSS clamping** côté concentrateur VPN. Le concentrateur ré-écrit le
  champ MSS du handshake TCP pour annoncer une valeur compatible avec le
  tunnel. Configuration locale au concentrateur, hors scope du repo.
- **Passer le serveur derrière un reverse-proxy TLS** (nginx / Caddy /
  Traefik). En plus de résoudre certaines politiques d'inspection
  middlebox, le proxy peut imposer ses propres options TCP (`mss`,
  `keepalive`) côté kernel. Cette migration est demandée séparément
  dans la roadmap (voir `Pistes pour la suite` du README).

---

## 4. Isoler la sensibilité à la taille du body — `curl`

Depuis le poste qui échoue, refaire la requête manuellement avec un body
minuscule et un body proche de la requête réelle :

```bash
# Body minimal (~20 octets) :
curl -v -X POST http://172.16.1.30:4000/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"emailOrUsername":"x"}'

# Body taille register (~200 octets) :
curl -v -X POST http://172.16.1.30:4000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"dummy@e2e.local","username":"dummy","displayName":"Dummy","password":"test1234","token":"abc"}'
```

- Si **les deux passent** : le bug ne dépend pas de la taille du body —
  cherchez ailleurs (cookie ? en-tête ? préflight ?).
- Si **seul le grand body fail** : c'est très probablement MTU/MSS du
  tunnel ou un IPS qui inspecte le contenu HTTP en clair.
- Si **les deux fail** : politique VPN générale sur les POST ou le port.

---

## 5. Exclure / confirmer le préflight CORS

Le navigateur envoie un `OPTIONS` avant la vraie requête quand celle-ci est
cross-origin avec un `Content-Type: application/json`. Si l'`OPTIONS`
échoue, Chrome remonte `Failed to fetch` mais **sans** `ERR_CONNECTION_RESET`
— cherchez plutôt « *CORS preflight* » dans les logs DevTools.

Vérifiez avec curl :

```bash
curl -v -X OPTIONS http://172.16.1.30:4000/auth/register \
  -H 'Origin: http://172.16.1.30:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

Le serveur répond actuellement avec `CORS_ORIGIN="*"` par défaut
(`server/src/index.js`), donc le préflight devrait passer. Si curl est OK
mais Chrome non, on n'est pas dans un problème CORS.

---

## 6. Rapporter dans l'issue

Une fois l'isolation faite, postez en commentaire de l'issue :

1. La conclusion ligne 1 du `[http]` access log : « la requête atteint Node »
   ou « jamais loggée → meurt en transit ».
2. Le résultat du `ping -f` (MTU effectif).
3. Le résultat des deux `curl` (petit vs gros body).
4. Si pcap : un screenshot Wireshark du RST avec la colonne `Info`.

Ces 4 éléments suffisent à classer l'incident dans :
- A) bug applicatif (rare ici, mais possible) → ouvrir une PR de fix.
- B) MTU/MSS → mitigation côté infra VPN, mention au README.
- C) Middlebox HTTP-plain → mitigation = HTTPS via reverse-proxy.

Aucun changement de code applicatif tant que (B) ou (C) n'est pas exclu.
