import { defineConfig } from "vitest/config";
import {
  TEST_DATABASE_URL,
  TEST_JWT_SECRET,
  TEST_ENCRYPTION_KEY,
  TEST_UPLOAD_DIR,
} from "./test/testEnv.js";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    globalSetup: "./test/globalSetup.js",
    setupFiles: "./test/setup.js",
    // These land in process.env in every worker BEFORE test modules (and their
    // imports, e.g. src/db.js's PrismaClient and src/crypto.js's key) load.
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      MESSAGE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      UPLOAD_DIR: TEST_UPLOAD_DIR,
      NODE_ENV: "test",
    },
    // One shared throwaway Postgres → run files sequentially so per-test
    // TRUNCATE in one file can't wipe another file's data mid-run.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
