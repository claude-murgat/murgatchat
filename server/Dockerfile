FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY scripts ./scripts

# Run as the built-in non-root `node` user. Pre-create the data dirs owned by it
# so FRESH named volumes inherit that ownership. NOTE: pre-existing prod volumes
# (uploads-data, server-meta) were created root-owned and must be chowned once —
# see the upgrade note in the PR / README before deploying this image.
RUN mkdir -p /data/uploads /data/meta && chown -R node:node /data
USER node

EXPOSE 4000

# Migrations versionnées : adopte une base héritée de `db push` (baseline de la
# migration initiale) puis applique les migrations en attente, avant le serveur.
CMD ["sh", "-c", "node scripts/db-migrate.js && node src/index.js"]
