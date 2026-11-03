<#
.SYNOPSIS
    Prévient le salon support-dev de MurgaChat quand un disque de ce serveur
    passe sous un palier d'espace libre (100 Go, puis 70 Go, puis 50 Go).

.DESCRIPTION
    Remplace la fenêtre d'avertissement (MessageBox) du script d'origine : lancé
    par une tâche planifiée sous le compte SYSTEM, personne ne la verrait.
    Chaque palier n'est signalé qu'une fois par disque, et réarmé quand l'espace
    libre remonte 5 Go au-dessus de lui. Le serveur du chat compose le message
    (POST /support/disk-alert), le script ne lui envoie que des chiffres.

    Installation : voir ops/README.md.

.PARAMETER Test
    Envoie tout de suite l'état du premier disque, marqué comme un test, sans
    tenir compte des paliers ni toucher à l'état mémorisé.
#>
# Garder les chaînes en ASCII : Windows PowerShell 5.1 lit un .ps1 sans BOM en
# ANSI, et un tiret long dans une chaîne y deviendrait un guillemet.
param(
    [string]$ChatUrl = "https://serveur-chat.charlesmurgat.com",
    [string]$Dossier = "$env:ProgramData\MurgaChat",
    [long[]]$Paliers = @(100GB, 70GB, 50GB),
    [long]$Marge = 5GB,
    [switch]$Test
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 ne propose pas toujours TLS 1.2 d'office.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$fichierJeton = Join-Path $Dossier "alerte-token.txt"
$fichierEtat = Join-Path $Dossier "alerte-disque.json"
if (-not (Test-Path $fichierJeton)) { throw "Jeton introuvable : $fichierJeton" }
$jeton = (Get-Content -Raw $fichierJeton).Trim()

function Send-Alerte($disque, [bool]$estTest) {
    $corps = @{
        host  = $env:COMPUTERNAME
        drive = $disque.DeviceID
        free  = [long]$disque.FreeSpace
        total = [long]$disque.Size
        test  = $estTest
    } | ConvertTo-Json -Compress
    # Corps en octets UTF-8 : une chaîne serait envoyée en ISO-8859-1 par la 5.1.
    Invoke-RestMethod -Method Post -Uri "$ChatUrl/support/disk-alert" `
        -Headers @{ Authorization = "Bearer $jeton" } `
        -ContentType "application/json" `
        -Body ([Text.Encoding]::UTF8.GetBytes($corps)) | Out-Null
}

$disques = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")

if ($Test) {
    Send-Alerte $disques[0] $true
    Write-Output "Message de test envoye pour $($disques[0].DeviceID)."
    return
}

# Palier déjà signalé pour chaque disque, d'un passage à l'autre.
$etat = @{}
if (Test-Path $fichierEtat) {
    try {
        (Get-Content -Raw $fichierEtat | ConvertFrom-Json).PSObject.Properties |
            ForEach-Object { $etat[$_.Name] = [long]$_.Value }
    } catch {
        # Fichier vide ou abîmé : on repart de zéro, au pire une alerte de trop.
        $etat = @{}
    }
}

$echec = $false
foreach ($d in $disques) {
    $libre = [long]$d.FreeSpace
    # Plus petit palier franchi, $null au-dessus du premier.
    $niveau = $Paliers | Where-Object { $libre -lt $_ } | Sort-Object | Select-Object -First 1
    $deja = $etat[$d.DeviceID]
    if ($niveau -and (-not $deja -or $niveau -lt $deja)) {
        try {
            Send-Alerte $d $false
            $etat[$d.DeviceID] = $niveau
        } catch {
            # Non mémorisé : l'alerte repartira au prochain passage.
            Write-Warning "Alerte $($d.DeviceID) non envoyee : $($_.Exception.Message)"
            $echec = $true
        }
    } elseif ($deja -and $libre -ge $deja + $Marge) {
        # Nettement remonté au-dessus du palier signalé : réarmé.
        if ($niveau) { $etat[$d.DeviceID] = $niveau } else { $etat.Remove($d.DeviceID) }
    }
}

$etat | ConvertTo-Json | Set-Content -Encoding UTF8 $fichierEtat
# Code 1 : la tâche planifiée affiche l'échec dans « Résultat de la dernière exécution ».
if ($echec) { exit 1 }
