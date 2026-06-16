import { io } from "socket.io-client";
import { getApiBaseUrl } from "./api.js";
import { logEvent, setLogContext } from "./logbuffer.js";

let socket = null;

// Record connection lifecycle into the diagnostic ring + keep the "socket"
// diagnostic field in sync. Bound once per socket instance.
function instrument(s) {
  setLogContext({ socket: "connecting" });
  s.on("connect", () => {
    setLogContext({ socket: "connected" });
    logEvent("info", `socket connected (${s.io?.engine?.transport?.name || "?"})`);
  });
  s.on("disconnect", (reason) => {
    setLogContext({ socket: "disconnected" });
    logEvent("warn", `socket disconnected: ${reason}`);
  });
  s.on("connect_error", (err) => {
    setLogContext({ socket: "error" });
    logEvent("error", `socket connect_error: ${err?.message || err}`);
  });
  s.io?.on("reconnect", (n) => logEvent("info", `socket reconnected after ${n} attempt(s)`));
}

export function getSocket(token) {
  if (socket && socket.connected) return socket;
  if (socket) socket.disconnect();
  // Resolve the server URL at connect time so it follows the runtime-configured
  // address (set on the login screen), not a value baked at build time.
  socket = io(getApiBaseUrl(), {
    auth: { token, platform: window.__TAURI__ ? "desktop" : "web" },
    transports: ["websocket", "polling"],
  });
  instrument(socket);
  return socket;
}

export function closeSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
