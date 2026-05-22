import { prisma } from "../../src/db.js";

export { prisma };

// Wipe every table between tests for isolation. CASCADE + RESTART IDENTITY so
// order is irrelevant and sequences reset. Fast enough to run in beforeEach.
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Reaction","Attachment","Message","Membership","PushToken","Channel","User" RESTART IDENTITY CASCADE'
  );
}
