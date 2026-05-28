// The server address is configurable at runtime from the login screen and
// persisted in localStorage, so the same build can point at any server (and the
// URL isn't baked into a public bundle). Falls back to the build-time
// VITE_API_URL, then localhost.
const DEFAULT_API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const API_BASE_KEY = "chat_api_base";

export function normalizeBaseUrl(raw) {
  let s = (raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

export function getDefaultBaseUrl() {
  return DEFAULT_API_URL;
}

export function getApiBaseUrl() {
  const stored =
    typeof localStorage !== "undefined" ? localStorage.getItem(API_BASE_KEY) : null;
  return normalizeBaseUrl(stored) || DEFAULT_API_URL;
}

export function setApiBaseUrl(url) {
  const normalized = normalizeBaseUrl(url);
  if (typeof localStorage !== "undefined") {
    if (normalized) localStorage.setItem(API_BASE_KEY, normalized);
    else localStorage.removeItem(API_BASE_KEY);
  }
  return normalized;
}

// Quick reachability probe for the "Tester" button on the login screen.
// Returns the full /health payload so the caller can also inspect needsBootstrap.
export async function pingServer(url) {
  const base = normalizeBaseUrl(url) || DEFAULT_API_URL;
  const res = await fetch(`${base}/health`, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (!data || data.ok !== true) throw new Error("réponse inattendue");
  return data;
}

export function getToken() {
  return localStorage.getItem("chat_token");
}
export function setToken(t) {
  if (t) localStorage.setItem("chat_token", t);
  else localStorage.removeItem("chat_token");
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
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
  const fd = new FormData();
  fd.append("file", file);
  const token = getToken();
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
  const token = getToken();
  return `${getApiBaseUrl()}/uploads/${id}?token=${encodeURIComponent(token || "")}`;
}

export const api = {
  get url() {
    return getApiBaseUrl();
  },
  register: (body) => request("/auth/register", { method: "POST", body, auth: false }),
  login: (body) => request("/auth/login", { method: "POST", body, auth: false }),
  me: () => request("/auth/me"),
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
    request("/auth/dnd-schedule", {
      method: "POST",
      body: { enabled, start, end },
    }),
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
  openDm: (userIds) =>
    request("/channels/dm", { method: "POST", body: { userIds } }),
  messages: (channelId) => request(`/channels/${channelId}/messages`),
  react: (id, emoji) =>
    request(`/channels/messages/${id}/reactions`, { method: "POST", body: { emoji } }),
  editMessage: (id, body) =>
    request(`/channels/messages/${id}`, { method: "PATCH", body: { body } }),
  deleteMessage: (id) =>
    request(`/channels/messages/${id}`, { method: "DELETE" }),
  scheduled: (channelId) => request(`/channels/${channelId}/scheduled`),
  deleteScheduled: (id) => request(`/channels/scheduled/${id}`, { method: "DELETE" }),
  updateScheduled: (id, body) =>
    request(`/channels/scheduled/${id}`, { method: "PATCH", body }),
};
