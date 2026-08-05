import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 exige un ADAPTATEUR DE DRIVER : le client ne lit plus l'URL depuis
// schema.prisma (voir prisma.config.ts). On passe donc la chaîne de connexion à
// l'adaptateur PostgreSQL, qui gère lui-même le pool. La variable d'environnement
// reste `DATABASE_URL` : rien ne change côté déploiement.
const adapter = new PrismaPg(process.env.DATABASE_URL as string);

export const prisma = new PrismaClient({ adapter });
