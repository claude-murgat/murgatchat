import { io } from "socket.io-client";
import { getApiBaseUrl } from "./api.js";

let socket = null;

export function getSocket(token) {
  if (socket && socket.connected) return socket;
  if (socket) socket.disconnect();
  // Resolve the server URL at connect time so it follows the runtime-configured
  // address (set on the login screen), not a value baked at build time.
  socket = io(getApiBaseUrl(), {
    auth: { token, platform: window.__TAURI__ ? "desktop" : "web" },
    transports: ["websocket", "polling"],
  });
  return socket;
}

export function closeSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
