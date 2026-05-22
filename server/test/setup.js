import { beforeEach, afterAll } from "vitest";
import { prisma, resetDb } from "./helpers/db.js";

// Runs in every test file (setupFiles): start each test from a clean DB and
// release the Prisma connection when the file finishes so forks exit cleanly.
beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});
