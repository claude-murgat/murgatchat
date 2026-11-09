#!/usr/bin/env bash
# Attend le verdict de la CI « tests » sur la PR ouverte par claude-fix pour une
# issue, et le publie dans $GITHUB_OUTPUT :
#   state  = green | red | unknown (pas de verdict) | none (aucune PR ouverte)
#   pr, url, branch, sha, run
#
# Si la CI est rouge, écrit dans .git/ci-failure.md de quoi la réparer : PR,
# branche, commit testé, jobs en échec et logs complets. Le fichier est dans .git
# pour ne jamais pouvoir être commité par mégarde.
#
# Sort toujours 0 : le verdict passe par les sorties, pas par le code de retour.
#
# Usage : wait-pr-ci.sh <numéro d'issue>
# Requiert GH_TOKEN avec `actions: read` et `pull-requests: read`.
set -uo pipefail

ISSUE="${1:?numéro d issue requis}"
WAIT_SECONDS="${CI_WAIT_SECONDS:-1500}"
POLL_SECONDS="${CI_POLL_SECONDS:-20}"
REPORT="$GITHUB_WORKSPACE/.git/ci-failure.md"

emit() { echo "$1=$2" >> "$GITHUB_OUTPUT"; }

# Même motif que l'étape de notification : `issue-<n>(-|$)` matche
# `claude/fix-issue-91` comme `claude/issue-91-2026…`, sans confondre #91 et #910.
if ! PR_LINE=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --limit 100 \
  --json number,url,headRefName,headRefOid \
  --jq '[.[] | select(.headRefName | test("issue-'"$ISSUE"'(-|$)"))] | .[0] // empty
        | "\(.number)\t\(.url)\t\(.headRefName)\t\(.headRefOid)"'); then
  echo "::warning::gh pr list a échoué → verdict de la CI inconnu"
  emit state unknown
  exit 0
fi
if [ -z "$PR_LINE" ]; then
  echo "Aucune PR ouverte pour l'issue #$ISSUE"
  emit state none
  exit 0
fi

IFS=$'\t' read -r PR URL BRANCH SHA <<<"$PR_LINE"
emit pr "$PR"
emit url "$URL"
emit branch "$BRANCH"
emit sha "$SHA"
echo "PR #$PR, branche $BRANCH, commit $SHA : attente de la CI…"

# Le run n'apparaît que quelques secondes après le push : on boucle aussi tant
# qu'il n'existe pas. Filtrer sur le SHA écarte les runs des commits précédents.
DEADLINE=$((SECONDS + WAIT_SECONDS))
while :; do
  RUN_LINE=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow tests.yml --branch "$BRANCH" --limit 20 \
    --json databaseId,headSha,status,conclusion \
    --jq '[.[] | select(.headSha == "'"$SHA"'")] | .[0] // empty
          | "\(.databaseId)\t\(.status)\t\(.conclusion)"') || RUN_LINE=""
  IFS=$'\t' read -r RUN_ID STATUS CONCLUSION <<<"$RUN_LINE"
  [ "$STATUS" = "completed" ] && break
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "::warning::pas de verdict de la CI après ${WAIT_SECONDS} s"
    emit state unknown
    exit 0
  fi
  sleep "$POLL_SECONDS"
done

RUN_URL="https://github.com/$GITHUB_REPOSITORY/actions/runs/$RUN_ID"
emit run "$RUN_ID"
echo "CI terminée : $CONCLUSION ($RUN_URL)"

case "$CONCLUSION" in
  success) emit state green; exit 0 ;;
  failure | timed_out) ;;
  *) emit state unknown; exit 0 ;;
esac

{
  echo "# CI rouge — PR #$PR (issue #$ISSUE)"
  echo
  echo "- Branche : \`$BRANCH\`"
  echo "- Commit testé : \`$SHA\`"
  echo "- Run : $RUN_URL"
  echo
  echo "## Jobs en échec"
  echo
  gh run view "$RUN_ID" --repo "$GITHUB_REPOSITORY" --json jobs \
    --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "- \(.name) (\(.conclusion))"'
  echo
  echo "## Logs des étapes en échec"
  echo
  # Format brut : « job<TAB>étape<TAB>horodatage ligne ». On retire l'horodatage et
  # les séquences de couleur, qui ne servent qu'à alourdir le fichier.
  gh run view "$RUN_ID" --repo "$GITHUB_REPOSITORY" --log-failed \
    | sed -E 's/\x1b\[[0-9;]*m//g; s/^([^\t]*\t[^\t]*\t)[^ ]+ /\1/'
} > "$REPORT"
echo "Rapport d'échec écrit dans $REPORT ($(wc -l < "$REPORT") lignes)"
emit state red
exit 0
