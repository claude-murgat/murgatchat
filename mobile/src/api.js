import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

// Precedence: explicit env override (used for web/dev) > app.json extra > Android-emulator default.
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  Constants.expoConfig?.extra?.API_URL ||
  "http://10.0.2.2:4000";

const TOKEN_KEY = "chat_token";
let cachedToken = null;

export async function getToken() {
  if (cachedToken) return cachedToken;
  cachedToken = await AsyncStorage.getItem(TOKEN_KEY);
  return cachedToken;
}
export async function setToken(t) {
  cachedToken = t || null;
  if (t) await AsyncStorage.setItem(TOKEN_KEY, t);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

export async function uploadFile(file) {
  // file: web -> Blob/File ; native -> { uri, name, type }
  const fd = new FormData();
  fd.append("file", file);
  const token = await getToken();
  const res = await fetch(`${API_URL}/uploads`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data.attachment;
}

export function attachmentUrl(id) {
  return `${API_URL}/uploads/${id}?token=${encodeURIComponent(cachedToken || "")}`;
}

export const api = {
  url: API_URL,
  register: (body) => request("/auth/register", { method: "POST", body, auth: false }),
  login: (body) => request("/auth/login", { method: "POST", body, auth: false }),
  me: () => request("/auth/me"),
  setDnd: (minutes) => request("/auth/dnd", { method: "POST", body: { minutes } }),
  setDndSchedule: (enabled, start, end) =>
    request("/auth/dnd-schedule", { method: "POST", body: { enabled, start, end } }),
  listUsers: (q) => request(`/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  listChannels: () => request("/channels"),
  createChannel: (body) => request("/channels", { method: "POST", body }),
  publicChannels: (q) =>
    request(`/channels/public${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  joinChannel: (id) => request(`/channels/${id}/join`, { method: "POST" }),
  addMembers: (id, userIds) =>
    request(`/channels/${id}/members`, { method: "POST", body: { userIds } }),
  leaveChannel: (id) => request(`/channels/${id}/leave`, { method: "POST" }),
  removeMember: (id, userId) =>
    request(`/channels/${id}/members/${userId}`, { method: "DELETE" }),
  openDm: (userIds) => request("/channels/dm", { method: "POST", body: { userIds } }),
  messages: (channelId) => request(`/channels/${channelId}/messages`),
  thread: (id) => request(`/channels/messages/${id}/thread`),
  react: (id, emoji) =>
    request(`/channels/messages/${id}/reactions`, { method: "POST", body: { emoji } }),
  editMessage: (id, body) =>
    request(`/channels/messages/${id}`, { method: "PATCH", body: { body } }),
  deleteMessage: (id) => request(`/channels/messages/${id}`, { method: "DELETE" }),
  scheduled: (channelId) => request(`/channels/${channelId}/scheduled`),
  deleteScheduled: (id) => request(`/channels/scheduled/${id}`, { method: "DELETE" }),
  updateScheduled: (id, body) =>
    request(`/channels/scheduled/${id}`, { method: "PATCH", body }),
};
