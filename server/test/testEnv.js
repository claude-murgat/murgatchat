// Single source of truth for the test environment, imported by both
// vitest.config.js (to populate process.env in workers) and globalSetup.js
// (to provision/migrate the disposable Postgres). Keeping it here avoids the
// two drifting apart.
//
// Locally we spin up a throwaway Postgres on port 5434 (the dev DB is on 5433
// and must never be touched). In CI, set TEST_DATABASE_URL to a service DB and
// globalSetup will skip Docker provisioning.

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://murgattest:murgattest@localhost:5434/murgattest?schema=public";

export const TEST_JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-murgat";

// 64 hex chars -> used directly as the AES-256 key (matches the dev/test key).
export const TEST_ENCRYPTION_KEY =
  process.env.MESSAGE_ENCRYPTION_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Writable dir for the uploads router's mkdirSync-at-import. Relative to server/.
export const TEST_UPLOAD_DIR = process.env.UPLOAD_DIR || "./.test-uploads";

// Mailpit (mail-catcher) for invitation-email tests. globalSetup spins a
// disposable container: SMTP on host 1026, HTTP API on host 8026.
export const TEST_SMTP_HOST = "localhost";
export const TEST_SMTP_PORT = process.env.TEST_SMTP_PORT || "1026";
export const TEST_MAILPIT_API = process.env.TEST_MAILPIT_API || "http://localhost:8026";
// Used to build invite links in emails (so tests can assert the link/code).
export const TEST_APP_URL = process.env.APP_URL || "http://localhost:5173";
