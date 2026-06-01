import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

// The server address is configured at runtime from the login screen and stored
// in AsyncStorage, so the SAME build can target any server. Crucially, the
// public Store build ships WITHOUT a baked server (empty default): a random
// downloader can't reach our server without knowing and typing its address.
// EXPO_PUBLIC_API_URL (or app.json extra.API_URL) only provides a DEV default.
const ENV_DEFAULT =
  process.env.EXPO_PUBLIC_API_URL || Constants.expoConfig?.extra?.API_URL || "";
const BASE_KEY = "chat_api_base";

// In-memory, read synchronously by request()/socket; hydrated from storage at
// startup via loadApiBaseUrl() (AsyncStorage is async).
let currentBaseUrl = ENV_DEFAULT;

export function normalizeBaseUrl(raw) {
  let s = (raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

export function getApiBaseUrl() {
  return currentBaseUrl;
}

export function getDefaultBaseUrl() {
  return ENV_DEFAULT;
}

// Call once at startup, before any authenticated request.
export async function loadApiBaseUrl() {
  try {
    const stored = await AsyncStorage.getItem(BASE_KEY);
    const n = normalizeBaseUrl(stored);
    if (n) currentBaseUrl = n;
  } catch {}
  return currentBaseUrl;
}

export async function setApiBaseUrl(url) {
  const n = normalizeBaseUrl(url);
  currentBaseUrl = n || ENV_DEFAULT;
  try {
    if (n) await AsyncStorage.setItem(BASE_KEY, n);
    else await AsyncStorage.removeItem(BASE_KEY);
  } catch {}
  return currentBaseUrl;
}

// Hard ceiling on any single request. Without it, an unreachable "black hole"
// server (no RST, just a hanging TCP connect — dropped VPN, unroutable IP, Wi-Fi
// off) leaves fetch() pending until the OS TCP timeout, which can be minutes and
// is what froze the cold-start splash (issue #42).
const REQUEST_TIMEOUT_MS = 10000;

// fetch() with a hard timeout. We use AbortController (universally available in
// RN) rather than AbortSignal.timeout() which isn't on every Hermes runtime.
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Reachability probe for the "Tester" button on the login screen.
// Returns the full /health payload so the caller can also inspect needsBootstrap.
export async function pingServer(url) {
  const base = normalizeBaseUrl(url) || currentBaseUrl;
  if (!base) throw new Error("adresse vide");
  let res;
  try {
    res = await fetchWithTimeout(`${base}/health`, { method: "GET" });
  } catch {
    throw new Error("délai dépassé ou injoignable");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (!data || data.ok !== true) throw new Error("réponse inattendue");
  return data;
}

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
  let res;
  try {
    res = await fetchWithTimeout(`${getApiBaseUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // No HTTP response: timeout (abort) or transport failure. Flag it so callers
    // can distinguish "server unreachable" from an auth rejection and avoid
    // destroying a still-valid session over a transient network blip (#42).
    throw Object.assign(new Error("Serveur injoignable"), { network: true, cause: e });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  // Carry the HTTP status so callers can react to 401/403 specifically.
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

export async function uploadFile(file) {
  // file: web -> Blob/File ; native -> { uri, name, type }
  const fd = new FormData();
  fd.append("file", file);
  const token = await getToken();
  const res = await fetch(`${getApiBaseUrl()}/uploads`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data.attachment;
}

export function attachmentUrl(id) {
  return `${getApiBaseUrl()}/uploads/${id}?token=${encodeURIComponent(cachedToken || "")}`;
}

export const api = {
  get url() {
    return getApiBaseUrl();
  },
  register: (body) => request("/auth/register", { method: "POST", body, auth: false }),
  login: (body) => request("/auth/login", { method: "POST", body, auth: false }),
  me: () => request("/auth/me"),
  version: () => request("/version", { auth: false }),
  updateProfile: (body) => request("/auth/me", { method: "PATCH", body }),
  forgotPassword: (emailOrUsername) =>
    request("/auth/forgot-password", {
      method: "POST",
      body: { emailOrUsername },
      auth: false,
    }),
  getPasswordReset: (token) =>
    request(`/auth/password-reset/${encodeURIComponent(token)}`, { auth: false }),
  resetPassword: (token, password) =>
    request("/auth/reset-password", {
      method: "POST",
      body: { token, password },
      auth: false,
    }),
  listAdminUsers: ({ page = 1, pageSize = 50, q = "" } = {}) => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (pageSize !== 50) params.set("pageSize", String(pageSize));
    if (q) params.set("q", q);
    const qs = params.toString();
    return request(`/auth/users${qs ? `?${qs}` : ""}`);
  },
  search: ({ q, channelId, limit } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (channelId) params.set("channelId", channelId);
    if (limit) params.set("limit", String(limit));
    return request(`/search?${params.toString()}`);
  },
  patchUser: (id, patch) =>
    request(`/auth/users/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  transferOwnership: (targetUserId) =>
    request("/auth/transfer-ownership", { method: "POST", body: { targetUserId } }),
  createInvitation: (email) =>
    request("/auth/invitations", { method: "POST", body: { email } }),
  listInvitations: () => request("/auth/invitations"),
  getInvitation: (token) =>
    request(`/auth/invitations/${encodeURIComponent(token)}`, { auth: false }),
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
  react: (id, emoji) =>
    request(`/channels/messages/${id}/reactions`, { method: "POST", body: { emoji } }),
  editMessage: (id, body) =>
    request(`/channels/messages/${id}`, { method: "PATCH", body: { body } }),
  deleteMessage: (id) => request(`/channels/messages/${id}`, { method: "DELETE" }),
  scheduled: (channelId) => request(`/channels/${channelId}/scheduled`),
  deleteScheduled: (id) => request(`/channels/scheduled/${id}`, { method: "DELETE" }),
  updateScheduled: (id, body) =>
    request(`/channels/scheduled/${id}`, { method: "PATCH", body }),
  registerPushToken: (token, platform) =>
    request("/auth/push-token", { method: "POST", body: { token, platform } }),
  removePushToken: (token) =>
    request("/auth/push-token", { method: "DELETE", body: { token } }),
};
