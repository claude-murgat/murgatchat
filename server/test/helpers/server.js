import { createServer } from "../../src/index.js";
import { io as ioClient } from "socket.io-client";

// Boot the real HTTP + Socket.IO server on an ephemeral port for WS tests.
export async function startTestServer() {
  const { app, server, io } = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  return {
    app,
    server,
    io,
    port,
    url,
    close: () =>
      new Promise((resolve) => {
        io.close();
        server.close(() => resolve());
      }),
  };
}

// Create a client socket WITHOUT waiting for connect, so callers can attach
// listeners (e.g. for the presence:state burst the server sends on connect)
// before any events arrive.
export function newSocket(url, token, platform = "web") {
  return ioClient(url, {
    auth: { token, platform },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
}

export function waitConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}

// Connect a Socket.IO client and resolve once it's connected.
export function connectSocket(url, token, platform = "web") {
  return waitConnect(newSocket(url, token, platform));
}

// Wait until the server has placed `socketId` into `channel:<channelId>`.
// The connection handler awaits a DB query before joining rooms and registering
// listeners, so the client "connect" event can fire before the socket is ready;
// joining the channel room happens in the same sync block as listener
// registration, so this is a reliable "fully set up" signal.
export async function waitInRoom(io, channelId, socketId, timeout = 3000) {
  const room = `channel:${channelId}`;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const members = io.sockets.adapter.rooms.get(room);
    if (members && members.has(socketId)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`socket ${socketId} never joined ${room}`);
}

// Resolve with the first event payload matching `predicate` (or the first event
// if no predicate), or reject after `timeout` ms.
export function waitForEvent(socket, event, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for "${event}"`));
    }, timeout);
    function handler(payload) {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

// Assert that `event` does NOT fire within `window` ms (resolves true if silent).
export function expectNoEvent(socket, event, window = 600) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(true);
    }, window);
    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      reject(new Error(`unexpected "${event}": ${JSON.stringify(payload)}`));
    }
    socket.on(event, handler);
  });
}
