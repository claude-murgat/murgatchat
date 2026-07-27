import type { ZodType } from "zod";
import type { NotifyLevel } from "./types.ts";
import { logEvent } from "./logbuffer.ts";
import { MessagesResponseSchema } from "../../shared/contracts.ts";

// The server address is configurable at runtime from the login screen and
// persisted in localStorage, so the same build can point at any server.
// Default precedence:
//   1. VITE_API_URL baked at build time (Docker web image sets it to the LAN IP)
//   2. localhost:4000 ONLY during local dev (`vite dev`)
//   3. otherwise empty — desktop/standalone builds ship with NO baked server,
//      forcing the user to enter the address on the login screen (parity with
//      the public mobile build).
const DEFAULT_API_URL =
  import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:4000" : "");
const API_BASE_KEY = "chat_api_base";

export function normalizeBaseUrl(raw: string | null | undefined) {
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

export function setApiBaseUrl(url: string | null | undefined) {
  const normalized = normalizeBaseUrl(url);
  if (typeof localStorage !== "undefined") {
    if (normalized) localStorage.setItem(API_BASE_KEY, normalized);
    else localStorage.removeItem(API_BASE_KEY);
  }
  return normalized;
}

// Quick reachability probe for the "Tester" button on the login screen.
// Returns the full /health payload so the caller can also inspect needsBootstrap.
export async function pingServer(url: string | null | undefined) {
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
export function setToken(t: string | null | undefined) {
  if (t) localStorage.setItem("chat_token", t);
  else localStorage.removeItem("chat_token");
}

// Turn a server error payload into a human-readable string. Most endpoints
// return { error: "some_code" }, but Zod validation failures return a
// flatten() object ({ formErrors, fieldErrors }) — an object that, if handed
// straight to `new Error()`, stringifies to the useless "[object Object]".
// Pull the first real message out of either shape (fields first, then form),
// falling back to the HTTP status text.
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    // Le payload n'est pas typé à la source (JSON.parse) : on décrit ici la forme
    // d'un flatten() zod pour lire les deux tableaux sans élargir en `any`.
    const flat = error as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    const fieldMsg = Object.values(flat.fieldErrors || ({} as Record<string, string[]>))
      .flat()
      .find((m) => typeof m === "string" && m);
    if (fieldMsg) return fieldMsg;
    const formMsg = (flat.formErrors || ([] as string[])).find(
      (m) => typeof m === "string" && m
    );
    if (formMsg) return formMsg;
  }
  return fallback;
}

interface RequestOptions {
  method?: string;
  /** Corps sérialisé en JSON — sa forme est propre à chaque endpoint. */
  body?: unknown;
  auth?: boolean;
}

async function request(
  path: string,
  { method = "GET", body, auth = true }: RequestOptions = {}
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Transport failure (offline, DNS, CORS). Breadcrumb the method+path only —
    // never the body — then rethrow for the caller to handle.
    logEvent(
      "error",
      `API network error ${method} ${path}: ${(e as { message?: string } | null)?.message || e}`
    );
    throw e;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = errorMessage(data.error, res.statusText);
    logEvent("warn", `API ${res.status} ${method} ${path}${message ? ` (${message})` : ""}`);
    throw Object.assign(new Error(message), { data });
  }
  return data;
}

export async function uploadFile(file: File | Blob) {
  const fd = new FormData();
  fd.append("file", file);
  const token = getToken();
  const res = await fetch(`${getApiBaseUrl()}/uploads`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  // Parse défensif : un upload trop lourd rejeté par un reverse-proxy (nginx
  // client_max_body_size) ou une passerelle revient en page d'erreur HTML, pas
  // en JSON — un res.json() aveugle jetterait « Unexpected token '<' » (l'erreur
  // que voyait le desktop). On tolère donc un corps non-JSON.
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    // 413 (notre API ou un proxy) = fichier trop lourd ; normalise le code pour
    // que l'UI affiche un message clair même quand le corps n'est pas du JSON.
    if (res.status === 413 && !data.error) data.error = "file_too_large";
    throw Object.assign(new Error(errorMessage(data.error, res.statusText)), {
      data,
      status: res.status,
    });
  }
  return data.attachment;
}

export function attachmentUrl(id: string) {
  const token = getToken();
  return `${getApiBaseUrl()}/uploads/${id}?token=${encodeURIComponent(token || "")}`;
}

// Vérif non-bloquante d'un contrat de données à une frontière : valide `data`,
// journalise un avertissement compact en cas d'écart (capté par le ring buffer de
// diagnostic), et RENVOIE toujours `data` tel quel — un décalage de schéma ne doit
// jamais casser l'UI. Schémas dans web/src/contracts.js (feuille de route typage, phase 1).
export function checkContract<T>(schema: ZodType, data: T, label: string): T {
  const res = schema.safeParse(data);
  if (!res.success) {
    const issues = res.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join(" | ");
    logEvent("warn", `[contract] ${label} — ${res.error.issues.length} écart(s): ${issues}`);
  }
  return data;
}

export const api = {
  get url() {
    return getApiBaseUrl();
  },
  register: (body: unknown) => request("/auth/register", { method: "POST", body, auth: false }),
  login: (body: unknown) => request("/auth/login", { method: "POST", body, auth: false }),
  me: () => request("/auth/me"),
  version: () => request("/version", { auth: false }),
  updateProfile: (body: unknown) => request("/auth/me", { method: "PATCH", body }),
  forgotPassword: (emailOrUsername: string) =>
    request("/auth/forgot-password", {
      method: "POST",
      body: { emailOrUsername },
      auth: false,
    }),
  getPasswordReset: (token: string) =>
    request(`/auth/password-reset/${encodeURIComponent(token)}`, { auth: false }),
  resetPassword: (token: string, password: string) =>
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
  search: ({ q, channelId, limit }: { q?: string; channelId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (channelId) params.set("channelId", channelId);
    if (limit) params.set("limit", String(limit));
    return request(`/search?${params.toString()}`);
  },
  patchUser: (id: string, patch: unknown) =>
    request(`/auth/users/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  transferOwnership: (targetUserId: string) =>
    request("/auth/transfer-ownership", { method: "POST", body: { targetUserId } }),
  createInvitation: (email: string) =>
    request("/auth/invitations", { method: "POST", body: { email } }),
  listInvitations: () => request("/auth/invitations"),
  getInvitation: (token: string) =>
    request(`/auth/invitations/${encodeURIComponent(token)}`, { auth: false }),
  setDnd: (minutes: number) => request("/auth/dnd", { method: "POST", body: { minutes } }),
  setDndSchedule: (enabled: boolean, start: string, end: string) =>
    request("/auth/dnd-schedule", {
      method: "POST",
      body: { enabled, start, end },
    }),
  listUsers: (q?: string) => request(`/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  listChannels: () => request("/channels"),
  createChannel: (body: unknown) => request("/channels", { method: "POST", body }),
  publicChannels: (q?: string) =>
    request(`/channels/public${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  joinChannel: (id: string) => request(`/channels/${id}/join`, { method: "POST" }),
  addMembers: (id: string, userIds: string[]) =>
    request(`/channels/${id}/members`, { method: "POST", body: { userIds } }),
  leaveChannel: (id: string) => request(`/channels/${id}/leave`, { method: "POST" }),
  // Niveau de notification par channel : "all" | "mentions" | "none".
  setChannelNotifyLevel: (id: string, level: NotifyLevel) =>
    request(`/channels/${id}/notifications`, { method: "PATCH", body: { level } }),
  removeMember: (id: string, userId: string) =>
    request(`/channels/${id}/members/${userId}`, { method: "DELETE" }),
  openDm: (userIds: string[]) =>
    request("/channels/dm", { method: "POST", body: { userIds } }),
  messages: (channelId: string, before?: string) =>
    request(
      `/channels/${channelId}/messages` +
        (before ? `?before=${encodeURIComponent(before)}` : "")
    ).then((d) => checkContract(MessagesResponseSchema, d, "GET /channels/:id/messages")),
  react: (id: string, emoji: string) =>
    request(`/channels/messages/${id}/reactions`, { method: "POST", body: { emoji } }),
  editMessage: (id: string, body: string) =>
    request(`/channels/messages/${id}`, { method: "PATCH", body: { body } }),
  deleteMessage: (id: string) =>
    request(`/channels/messages/${id}`, { method: "DELETE" }),
  scheduled: (channelId: string) => request(`/channels/${channelId}/scheduled`),
  deleteScheduled: (id: string) => request(`/channels/scheduled/${id}`, { method: "DELETE" }),
  updateScheduled: (id: string, body: unknown) =>
    request(`/channels/scheduled/${id}`, { method: "PATCH", body }),
  // Web Push (browser PWA, including iOS via Add to Home Screen). The VAPID
  // public key is needed by the service worker to subscribe.
  webPushVapidKey: () => request("/auth/web-push/vapid-public-key", { auth: false }),
  webPushSubscribe: (body: unknown) =>
    request("/auth/web-push/subscribe", { method: "POST", body }),
  webPushUnsubscribe: (endpoint: string) =>
    request("/auth/web-push/subscribe", { method: "DELETE", body: { endpoint } }),
  // Bug reports: any user can file one; admins consult/triage them.
  reportBug: (body: unknown) => request("/bug-reports", { method: "POST", body }),
  // Support conversation: chat with Claude to refine a ticket. startSupport may
  // throw a 503 (support_chat_unavailable) when no ANTHROPIC_API_KEY is set —
  // callers fall back to reportBug.
  startSupport: (body: unknown) => request("/support/conversations", { method: "POST", body }),
  sendSupport: (id: string, body: unknown) =>
    request(`/support/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body,
    }),
  listBugReports: ({ page = 1, pageSize = 30, status = "" } = {}) => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (pageSize !== 30) params.set("pageSize", String(pageSize));
    if (status) params.set("status", status);
    const qs = params.toString();
    return request(`/bug-reports${qs ? `?${qs}` : ""}`);
  },
  updateBugReport: (id: string, status: string) =>
    request(`/bug-reports/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } }),
  deleteBugReport: (id: string) =>
    request(`/bug-reports/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // GIF picker (GIPHY proxied server-side). Empty q → trending.
  gifSearch: ({ q = "", pos = 0 } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (pos) params.set("pos", String(pos));
    const qs = params.toString();
    return request(`/gifs/search${qs ? `?${qs}` : ""}`);
  },
  importGif: (url: string) => request("/gifs/import", { method: "POST", body: { url } }),
};
