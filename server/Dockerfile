FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY scripts ./scripts

EXPOSE 4000

# Migrations versionnées : adopte une base héritée de `db push` (baseline de la
# migration initiale) puis applique les migrations en attente, avant le serveur.
CMD ["sh", "-c", "node scripts/db-migrate.js && node src/index.js"]
