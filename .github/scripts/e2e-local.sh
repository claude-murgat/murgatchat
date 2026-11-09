#!/usr/bin/env bash
# Rejoue la suite e2e sur le runner self-hosted, dans les conditions du job
# « e2e » de tests.yml : stack isolée bâtie depuis l'arbre courant, Playwright à
# la version du lockfile, CI=true (retries et reporter identiques).
#
# Usage :
#   .github/scripts/e2e-local.sh                       toute la suite
#   .github/scripts/e2e-local.sh tests/foo.spec.js     pour itérer sur un test
#
# Les tests tournent sur une COPIE interne au conteneur (e2e/ est monté en lecture
# seule) : le conteneur est root et le runner n'a pas sudo, or un fichier root
# laissé dans le workspace bloque ensuite les checkouts (cf. claude-fix.yml).
# Pour la même raison, rien ne dépend du e2e/node_modules resté d'un run précédent.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
COMPOSE=(docker compose -f docker-compose.e2e.yml)

VERSION=$(jq -r '.packages["node_modules/@playwright/test"].version' e2e/package-lock.json)
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "Version de Playwright introuvable dans e2e/package-lock.json" >&2
  exit 1
fi

trap '"${COMPOSE[@]}" down -v >/dev/null 2>&1' EXIT

"${COMPOSE[@]}" up -d --build || exit 1

ready=""
for _ in $(seq 1 60); do
  if curl -sf http://localhost:4001/health >/dev/null && curl -sf http://localhost:5174 >/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "La stack e2e n'a pas démarré" >&2
  "${COMPOSE[@]}" logs --tail=80
  exit 1
fi

# shellcheck disable=SC2016 # "$@" est développé par le bash du conteneur.
docker run --rm --network host \
  -e CI=true \
  -e E2E_BASE_URL=http://localhost:5174 \
  -v "$PWD/e2e":/src:ro \
  "mcr.microsoft.com/playwright:v${VERSION}-noble" \
  bash -c '
    set -e
    mkdir /e2e
    tar -C /src --exclude=./node_modules --exclude=./test-results --exclude=./playwright-report -cf - . \
      | tar -C /e2e -xf -
    cd /e2e
    npm ci --no-audit --no-fund
    npx playwright test "$@"
  ' _ "$@"
