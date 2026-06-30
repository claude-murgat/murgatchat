// Applique le schéma via des migrations versionnées (`prisma migrate deploy`).
//
// Adopte sans douleur une base créée par l'ancien `prisma db push` : si le schéma
// est déjà présent mais sans historique `_prisma_migrations`, on « baseline » la
// migration initiale comme déjà appliquée, pour que `deploy` ne tente pas de
// recréer des tables existantes (ce qui échouerait). No-op sur une base fraîche
// (deploy crée tout) ou déjà sous contrôle de migrations.
//
// Lancé par le CMD du Dockerfile avant le serveur. Échoue bruyamment (exit 1) si
// la base est injoignable ou une migration casse — on ne démarre pas le serveur
// sur un schéma incertain.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const INIT = "0_init";
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });

async function isLegacyDbPush() {
  const prisma = new PrismaClient();
  try {
    // Base héritée de `db push` = une table connue existe mais la table
    // d'historique des migrations n'a jamais été créée.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT (to_regclass('public."User"') IS NOT NULL
               AND to_regclass('public._prisma_migrations') IS NULL) AS legacy`
    );
    return rows?.[0]?.legacy === true;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (await isLegacyDbPush()) {
    console.log(`[db-migrate] schéma « db push » hérité détecté → baseline ${INIT}`);
    sh(`npx prisma migrate resolve --applied ${INIT}`);
  }
  sh("npx prisma migrate deploy");
}

main().catch((e) => {
  console.error("[db-migrate] échec:", e?.message || e);
  process.exit(1);
});
