# Scripts d'exploitation

## `alerte-disque.ps1` : disque presque plein sur le serveur TSE

Toutes les heures, une tâche planifiée mesure les disques locaux du serveur. Quand
l'espace libre d'un disque passe sous **100 Go**, puis **70 Go**, puis **50 Go**, elle
poste dans le salon **support-dev** (admins du chat), par exemple :

> ⚠️ Disque C: du serveur TSE01 occupé à 91 % : il reste 42,3 Go sur 500,0 Go.

Chaque palier n'est signalé qu'une fois par disque, et il est réarmé quand l'espace
libre remonte 5 Go au-dessus de lui. Le palier signalé est gardé dans
`alerte-disque.json`, à côté du script.

Le script appelle `POST /support/disk-alert` du serveur du chat avec le secret
`SUPPORT_NOTIFY_TOKEN` (celui du pipeline `claude-fix`). Il n'envoie que des
chiffres : le serveur compose le message.

### Installation (PowerShell en administrateur, sur le TSE)

Le jeton donne le droit de poster dans support-dev. Sur un TSE, tous les utilisateurs
ont une session : le dossier est donc fermé à tous sauf SYSTEM et les administrateurs.

```powershell
# 1. Dossier réservé à SYSTEM (S-1-5-18) et aux administrateurs (S-1-5-32-544)
$d = "$env:ProgramData\MurgaChat"
New-Item -ItemType Directory -Force $d | Out-Null
icacls $d /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"

# 2. Le script (copié tel quel : il est en UTF-8 avec BOM)
Copy-Item .\alerte-disque.ps1 $d
Unblock-File "$d\alerte-disque.ps1"

# 3. Le jeton : la valeur de SUPPORT_NOTIFY_TOKEN dans le .env du serveur du chat
$s = Read-Host "Jeton" -AsSecureString
[pscredential]::new("x", $s).GetNetworkCredential().Password |
    Set-Content -NoNewline -Encoding ASCII "$d\alerte-token.txt"

# 4. Tâche planifiée : toutes les heures, sous le compte SYSTEM
$system  = ([Security.Principal.SecurityIdentifier]"S-1-5-18").Translate([Security.Principal.NTAccount]).Value
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$d\alerte-disque.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "MurgaChat - alerte disque" -Action $action `
    -Trigger $trigger -User $system -RunLevel Highest

# 5. Vérification : un message « Test de l'alerte disque » doit arriver dans support-dev
powershell -NoProfile -ExecutionPolicy Bypass -File "$d\alerte-disque.ps1" -Test
```

Par défaut le script vise `https://serveur-chat.charlesmurgat.com`. Si le TSE ne la
joint pas, ajoutez `-ChatUrl http://172.16.1.30:4000` à l'argument de la tâche.

En cas d'échec d'envoi (serveur injoignable, jeton refusé), le palier n'est pas
mémorisé : l'alerte repart au passage suivant. La tâche planifiée affiche alors `0x1`
dans « Résultat de la dernière exécution ».
