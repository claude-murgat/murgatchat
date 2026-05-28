import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import cors from "cors";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import channelsRouter, { ensureDefaultChannel } from "./routes/channels.js";
import uploadsRouter from "./routes/uploads.js";
import { setupSocket, dispatchScheduledMessages } from "./socket.js";
import { prisma } from "./db.js";

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

  return { app, server, io };
}

export function startServer() {
  const { server, io } = createServer();

  setInterval(() => {
    dispatchScheduledMessages(io).catch((e) =>
      console.error("dispatchScheduledMessages error", e)
    );
  }, 10_000);

  server.listen(PORT, () => {
    console.log(`Chat server listening on :${PORT}`);
    ensureDefaultChannel()
      .then((c) => console.log(`Default channel ready: ${c.name} (${c.id})`))
      .catch((e) => console.error("ensureDefaultChannel error", e));
  });

  return { server, io };
}

// Only auto-start when run directly (node src/index.js), not when imported.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer();
}
