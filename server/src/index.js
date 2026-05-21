import http from "node:http";
import express from "express";
import cors from "cors";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import channelsRouter, { ensureDefaultChannel } from "./routes/channels.js";
import uploadsRouter from "./routes/uploads.js";
import { setupSocket, dispatchScheduledMessages } from "./socket.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = setupSocket(server, CORS_ORIGIN);

app.use((req, _res, next) => {
  req.io = io;
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/channels", channelsRouter);
app.use("/uploads", uploadsRouter);

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
