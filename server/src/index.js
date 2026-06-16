import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import express from "express";
import cors from "cors";
import authRouter, { ensureOwner, ensureLowercaseIdentifiers } from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import channelsRouter, { ensureDefaultChannel } from "./routes/channels.js";
import uploadsRouter from "./routes/uploads.js";
import searchRouter, { ensureSearchIndex } from "./routes/search.js";
import bugReportsRouter from "./routes/bugReports.js";
import { setupSocket, dispatchScheduledMessages } from "./socket.js";
import { prisma } from "./db.js";
import { sweepOrphanAttachments } from "./sweep.js";
import { initWebPush } from "./webpush.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Version advertised to clients for the in-app update prompt. Set CLIENT_VERSION
// to the version you just published (e.g. "0.5.3") so older clients prompt to
// update. Without it we fall back to the server package version, which is lower
// than any shipped client → no prompt (safe default / feature off).
function serverPackageVersion() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const CLIENT_VERSION = process.env.CLIENT_VERSION || serverPackageVersion();
// Where the desktop "Download" button and release notes point.
const DOWNLOAD_URL =
  process.env.DOWNLOAD_URL || "https://github.com/claude-murgat/murgatchat/releases/latest";

// Build the HTTP + Socket.IO server without listening, so tests can boot it on
// an ephemeral port (or drive the Express app directly via supertest).
export function createServer() {
  // VAPID keys must be ready before any /auth/web-push/* route can serve.
  initWebPush();

  const app = express();
  app.use(cors({ origin: CORS_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));

  const server = http.createServer(app);
  const io = setupSocket(server, CORS_ORIGIN);

  app.use((req, _res, next) => {
    req.io = io;
    next();
  });

  // Public probe used by the login screen's "Tester" button. Also exposes
  // `needsBootstrap` so a fresh deploy can hint "no admin yet — create one"
  // in the UI without anyone having to find the empty-invitation-code trick.
  app.get("/health", async (_req, res) => {
    let needsBootstrap = false;
    try {
      needsBootstrap = (await prisma.user.count()) === 0;
    } catch {
      // DB unreachable: keep ok:true so the user still sees the server is up
      // (the misleading flag won't be needed if /health itself is failing).
    }
    res.json({ ok: true, needsBootstrap });
  });

  // Public: the client compares its baked version to this and prompts to update
  // (web → refresh, desktop → download installer, mobile → info banner).
  app.get("/version", (_req, res) => {
    res.json({ version: CLIENT_VERSION, downloadUrl: DOWNLOAD_URL });
  });
  app.use("/auth", authRouter);
  app.use("/users", usersRouter);
  app.use("/channels", channelsRouter);
  app.use("/uploads", uploadsRouter);
  app.use("/search", searchRouter);
  app.use("/bug-reports", bugReportsRouter);

  return { app, server, io };
}

export function startServer() {
  const { server, io } = createServer();

  setInterval(() => {
    dispatchScheduledMessages(io).catch((e) =>
      console.error("dispatchScheduledMessages error", e)
    );
  }, 10_000);

  // Hourly sweep of orphan blobs + abandoned uploads. First pass is delayed
  // 5 min so we don't wipe in-flight files right after a restart.
  const runSweep = () =>
    sweepOrphanAttachments()
      .then(({ filesDeleted, rowsDeleted }) => {
        if (filesDeleted + rowsDeleted > 0) {
          console.log(`[sweep] cleaned ${filesDeleted} blob(s) + ${rowsDeleted} row(s)`);
        }
      })
      .catch((e) => console.error("[sweep] error:", e.message));
  setTimeout(runSweep, 5 * 60_000);
  setInterval(runSweep, 60 * 60_000);

  server.listen(PORT, () => {
    console.log(`Chat server listening on :${PORT}`);
    ensureDefaultChannel()
      .then((c) => console.log(`Default channel ready: ${c.name} (${c.id})`))
      .catch((e) => console.error("ensureDefaultChannel error", e));
    // Backfill `isOwner` for pre-existing deployments: if there's at least
    // one admin but no owner, the oldest admin is promoted.
    ensureOwner()
      .then((o) => o && console.log(`Owner ready: ${o.username} (${o.id})`))
      .catch((e) => console.error("ensureOwner error", e));
    // Lowercase legacy mixed-case usernames + emails so case-insensitive login
    // works for accounts created before this rollout. Collision-safe + no-op once done.
    ensureLowercaseIdentifiers().catch((e) =>
      console.error("ensureLowercaseIdentifiers error", e)
    );
    // Idempotent: creates the GIN expression index on Message.searchableBody
    // if it doesn't already exist. No-op after the first boot post-rollout.
    ensureSearchIndex()
      .then(() => console.log("Search index ready"))
      .catch((e) => console.error("ensureSearchIndex error", e));
  });

  return { server, io };
}

// Only auto-start when run directly (node src/index.js), not when imported.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer();
}
