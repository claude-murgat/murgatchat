#!/usr/bin/env bash
# Rend lisible, dans les logs du job GitHub Actions, la transcription d'une
# exécution claude-code-action. L'action écrit un « execution_file » : un tableau
# JSON de messages SDK (système / assistant / outils / résultat), via
# JSON.stringify(messages, null, 2). Affiché brut, c'est illisible (cf. issue
# #126, où show_full_output déversait ce JSON). Ce script le transforme en un fil
# texte montrant le déroulé de Claude (ses messages + appels d'outils + résultats
# tronqués + résultat final), pour suivre étape par étape sans déchiffrer du JSON
# — aussi bien pour claude-fix que pour la revue IA.
#
# Best-effort : ne fait JAMAIS échouer le job appelant (toujours exit 0).
# Usage : format-claude-log.sh <chemin-du-execution_file>
set -u

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Transcription Claude indisponible (fichier d'exécution introuvable : '${FILE:-<vide>}')."
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq absent du runner : transcription Claude non formatée (voir le fichier brut $FILE)."
  exit 0
fi

# Le programme jq est en quotes simples : il ne contient AUCUNE apostrophe.
jq -r '
  def trunc($n): if (. | length) > $n then (.[0:$n] + " ...[tronque]") else . end;
  # Le contenu dun tool_result est soit une chaine, soit un tableau {type,text}.
  def astext:
    if type == "string" then .
    elif type == "array" then ([ .[] | (.text // .content // "") ] | map(select(. != "")) | join("\n"))
    else (. | tostring) end;
  def kv: to_entries | map("\(.key)=\((.value | tostring) | .[0:80])") | join(", ");

  .[] |
  if .type == "system" and .subtype == "init" then
    "\n== Claude initialise (modele : \(.model // "?")) =="
  elif .type == "assistant" then
    ( .message.content // [] | .[] |
      if .type == "text" then
        ( (.text // "") | select(. != "") | "\nClaude > \(.)" )
      elif .type == "tool_use" then
        "  * outil \(.name)\(if (.input | type) == "object" and ((.input | length) > 0) then " (" + (.input | kv) + ")" else "" end)"
      else empty end )
  elif .type == "user" then
    ( .message.content // [] | .[] |
      if .type == "tool_result" then
        ( ((.content // "") | astext | trunc(800)) as $c |
          if (.is_error // false) then "    -> erreur : \($c)" else "    -> \($c)" end )
      else empty end )
  elif .type == "result" then
    "\n== Resultat final ==\n\((.result // "") | astext)\n(tours : \(.num_turns // "?") - duree : \(((.duration_ms // 0) / 1000) | floor)s - cout : $\(.total_cost_usd // 0))"
  else empty end
' "$FILE" || echo "Formatage de la transcription Claude impossible (JSON inattendu) ; fichier brut : $FILE"

exit 0
