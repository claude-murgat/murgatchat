FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache openssl

# Contexte de build = RACINE du repo (voir docker-compose : context: .), pour
# embarquer le mini-package de contrats `shared/` en plus de `server/`.
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev || npm install

# prisma.config.ts est indispensable depuis Prisma 7 : c'est lui qui porte
# l'URL de connexion pour la CLI (migrations au démarrage, cf. CMD plus bas),
# schema.prisma ne l'accepte plus.
COPY server/prisma ./prisma
COPY server/prisma.config.ts ./
RUN npx prisma generate

COPY server/src ./src
COPY server/scripts ./scripts

# Mini-package de contrats à /shared : server/src importe ../../shared -> /shared
# depuis /app/src. Contrairement au web, le serveur exécute contracts.js tel quel
# (pas de bundling), donc `zod` doit être résoluble depuis /shared -> on installe
# SON node_modules ici (le node_modules est exclu du contexte, on le reconstruit).
COPY shared/package.json shared/package-lock.json* /shared/
RUN cd /shared && npm install --omit=dev
COPY shared/ /shared/

# Run as the built-in non-root `node` user. Pre-create the data dirs owned by it
# so FRESH named volumes inherit that ownership. NOTE: pre-existing prod volumes
# (uploads-data, server-meta) were created root-owned and must be chowned once —
# see the upgrade note in the PR / README before deploying this image.
RUN mkdir -p /data/uploads /data/meta && chown -R node:node /data
USER node

EXPOSE 4000

# Migrations versionnées : adopte une base héritée de `db push` (baseline de la
# migration initiale) puis applique les migrations en attente, avant le serveur.
CMD ["sh", "-c", "node scripts/db-migrate.js && node src/index.ts"]
