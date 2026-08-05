// Configuration de la CLI Prisma (migrations, generate, studio).
//
// Depuis Prisma 7, `datasource.url` n'est plus accepté dans schema.prisma :
// l'adresse de connexion se déclare ici pour les OUTILS, et via un adaptateur de
// driver pour l'EXÉCUTION (voir src/db.ts). Les deux lisent la même variable
// d'environnement, il n'y a donc qu'une seule source de vérité.
// ⚠ On lit `process.env` directement plutôt que le helper `env()` de Prisma :
// celui-ci évalue la variable AVIDEMENT et lève si elle est absente, ce qui
// casserait `prisma generate` — qui n'a pourtant besoin d'aucune connexion.
// Ici, l'URL vaut simplement `undefined` quand la variable n'est pas définie :
// `generate` passe, et seules les commandes qui touchent vraiment la base
// (migrate, studio) échouent, avec un message explicite.
import { join } from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 ne lit PLUS le `.env` tout seul (Prisma 6 le faisait via `env()` dans
// schema.prisma). Sans ça, `npx prisma migrate dev` contre une base jetable —
// le workflow décrit au README — ne trouverait plus l'URL. On le recharge donc
// ici, aux deux emplacements historiques de Prisma, avec `loadEnvFile` (natif
// Node ≥ 20.12, aucune dépendance). Une variable déjà définie dans
// l'environnement l'emporte sur le fichier : docker-compose et la CI, qui
// passent DATABASE_URL directement, ne peuvent pas être court-circuités.
for (const f of [".env", join("prisma", ".env")]) {
  try {
    process.loadEnvFile(join(import.meta.dirname, f));
  } catch {
    // Fichier absent (cas normal en conteneur et en CI) : rien à charger.
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
