import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TEST_DATABASE_URL } from "./testEnv.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");
const prismaCli = join(serverRoot, "node_modules", "prisma", "build", "index.js");

const CONTAINER = "murgat-test-db";
const MAIL_CONTAINER = "murgat-test-mail";
// If a DB URL is provided (CI service container), don't manage Docker ourselves.
const externalDb = !!process.env.TEST_DATABASE_URL;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", ...opts });
}

function pgReady() {
  try {
    run("docker", ["exec", CONTAINER, "pg_isready", "-U", "murgattest", "-d", "murgattest"]);
    return true;
  } catch {
    return false;
  }
}

async function mailReady() {
  try {
    const res = await fetch("http://localhost:8026/api/v1/messages");
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup() {
  if (!externalDb) {
    // Recreate from scratch every run for a clean, isolated DB.
    try {
      run("docker", ["rm", "-f", CONTAINER]);
    } catch {
      /* not running yet */
    }
    run("docker", [
      "run", "-d", "--name", CONTAINER,
      "-e", "POSTGRES_USER=murgattest",
      "-e", "POSTGRES_PASSWORD=murgattest",
      "-e", "POSTGRES_DB=murgattest",
      "-p", "5434:5432",
      "postgres:16-alpine",
    ]);

    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (pgReady()) {
        ready = true;
        break;
      }
      await sleep(1000);
    }
    if (!ready) throw new Error("test Postgres did not become ready within 60s");
  }

  // Mail-catcher (Mailpit) for invitation-email tests: SMTP 1026, HTTP API 8026.
  try {
    run("docker", ["rm", "-f", MAIL_CONTAINER]);
  } catch {
    /* not running yet */
  }
  run("docker", [
    "run", "-d", "--name", MAIL_CONTAINER,
    "-p", "1026:1025",
    "-p", "8026:8025",
    "axllent/mailpit",
  ]);
  let mailUp = false;
  for (let i = 0; i < 60; i++) {
    if (await mailReady()) {
      mailUp = true;
      break;
    }
    await sleep(500);
  }
  if (!mailUp) throw new Error("Mailpit did not become ready within 30s");

  // Create the schema on the empty test DB (no migration history needed).
  run(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}

export async function teardown() {
  if (!externalDb) {
    try {
      run("docker", ["rm", "-f", CONTAINER]);
    } catch {
      /* already gone */
    }
  }
  try {
    run("docker", ["rm", "-f", MAIL_CONTAINER]);
  } catch {
    /* already gone */
  }
}
