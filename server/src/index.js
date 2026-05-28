import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import cors from "cors";
import authRouter, { ensureOwner } from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import channelsRouter, { ensureDefaultChannel } from "./routes/channels.js";
import uploadsRouter from "./routes/uploads.js";
import searchRouter, { ensureSearchIndex } from "./routes/search.js";
import { setupSocket, dispatchScheduledMessages } from "./socket.js";
import { prisma } from "./db.js";
import { sweepOrphanAttachments } from "./sweep.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Build the HTTP + Socket.IO server without listening, so tests can boot it on
// an ephemeral port (or drive the Express app directly via supertest).
export function createServer() {
  const app = express();
  app.use(cors({ origin: CORS_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));

  const server = http.createServer(app);
  const io = setupSocket(server, CORS_ORIGIN);

  app.use((req, _res, next) => {
    req.io = io;
    next();
  });

  // Opt-in access log (DEBUG_HTTP=1). Used during alpha-test to confirm or
  // exclude the server when a request seems to die in transit (e.g. VPN issue
  // GH#30). Logs method + url + request body size + status + duration. No PII
  // is logged — bodies stay encrypted and out of stdout. See DEBUGGING.md.
  if (process.env.DEBUG_HTTP === "1") {
    app.use((req, res, next) => {
      const start = Date.now();
      const cl = req.headers["content-length"] || "-";
      res.on("finish", () => {
        const dur = Date.now() - start;
        console.log(
          `[http] ${req.method} ${req.url} body=${cl}o status=${res.statusCode} ${dur}ms ip=${req.ip}`
        );
      });
      next();
    });
  }

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
  app.use("/auth", authRouter);
  app.use("/users", usersRouter);
  app.use("/channels", channelsRouter);
  app.use("/uploads", uploadsRouter);
  app.use("/search", searchRouter);

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
