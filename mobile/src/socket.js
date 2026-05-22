import { io } from "socket.io-client";
import { API_URL } from "./api";

let socket = null;

export function getSocket(token) {
  if (socket && socket.connected) return socket;
  if (socket) socket.disconnect();
  socket = io(API_URL, {
    auth: { token },
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
