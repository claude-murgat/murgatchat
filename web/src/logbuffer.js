// In-memory diagnostic log buffer for bug reports (web / PWA / desktop).
//
// Captures console.warn/error + explicit app breadcrumbs into a bounded ring,
// alongside a diagnostic header (version, platform, server URL, socket/notif
// state, screen, locale). It is deliberately dependency-light — context that
// would create an import cycle (server URL, current user, socket state) is
// pushed in via setLogContext() rather than imported.
//
// PRIVACY: this never stores message bodies. Breadcrumbs are events and IDs
// only (e.g. "socket disconnected", "API 500 on /channels"), so a report can be
// shared with an admin without leaking conversation content.

const MAX_ENTRIES = 300; // ring size; oldest dropped past this
const MAX_LINE = 1000; // truncate any single oversized line

const ring = [];
let installed = false;
let context = {}; // { userId, username, serverUrl, socket }

// Baked at build time (vite define). Read directly rather than via version.js to
// keep this module free of the api.js import chain (avoids a cycle).
const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

function fmt(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function push(level, text) {
  const s = String(text);
  ring.push({
    t: Date.now(),
    level,
    msg: s.length > MAX_LINE ? s.slice(0, MAX_LINE) + "…" : s,
  });
  if (ring.length > MAX_ENTRIES) ring.shift();
}

// Record an explicit app breadcrumb (use sparingly — lifecycle, not data).
export function logEvent(level, ...args) {
  push(level, fmt(args));
}
export const logInfo = (...a) => logEvent("info", ...a);
export const logWarn = (...a) => logEvent("warn", ...a);
export const logError = (...a) => logEvent("error", ...a);

// Merge diagnostic context (caller-owned: server URL, user, socket state).
export function setLogContext(patch) {
  context = { ...context, ...patch };
}

export function platformLabel() {
  if (typeof window !== "undefined" && window.__TAURI__) return "desktop";
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(display-mode: standalone)")?.matches
  )
    return "pwa";
  if (typeof navigator !== "undefined" && navigator.standalone) return "pwa"; // iOS
  return "web";
}

// One-shot: mirror console.warn/error into the ring and catch global errors.
export function installLogCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  for (const level of ["warn", "error"]) {
    const orig = console[level] ? console[level].bind(console) : null;
    if (!orig) continue;
    console[level] = (...args) => {
      try {
        push(level, fmt(args));
      } catch {
        /* never let logging break the app */
      }
      orig(...args);
    };
  }

  window.addEventListener("error", (e) => {
    push("error", `window.onerror: ${e.message} @ ${e.filename || "?"}:${e.lineno || 0}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    push("error", `unhandledrejection: ${(r && (r.message || r)) || "unknown"}`);
  });

  logInfo(`diagnostic capture started · ${platformLabel()} · v${APP_VERSION}`);
}

// Structured diagnostic header sent alongside a report and shown in the preview.
export function getDiagnostics(extra = {}) {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const scr = typeof window !== "undefined" && window.screen ? window.screen : {};
  const out = {
    appVersion: APP_VERSION,
    platform: platformLabel(),
    serverUrl: context.serverUrl,
    userId: context.userId,
    username: context.username,
    socket: context.socket,
    notif:
      typeof Notification !== "undefined" ? Notification.permission : "unsupported",
    online: typeof nav.onLine === "boolean" ? nav.onLine : undefined,
    language: nav.language,
    userAgent: nav.userAgent,
    screen: scr.width ? `${scr.width}×${scr.height}` : undefined,
    viewport:
      typeof window !== "undefined"
        ? `${window.innerWidth}×${window.innerHeight}`
        : undefined,
    time: new Date().toISOString(),
    ...extra,
  };
  // Drop empty keys so the header stays tidy.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") delete out[k];
  }
  return out;
}

// Just the log lines (no header) — used for the report's `logs` field.
export function getLogLines() {
  return ring
    .map((e) => `${new Date(e.t).toISOString()} [${e.level}] ${e.msg}`)
    .join("\n");
}

export function entryCount() {
  return ring.length;
}

// Human-readable dump (header + logs) for the clipboard / .txt download.
export function dumpText(extra = {}) {
  const diag = getDiagnostics(extra);
  const header = Object.entries(diag)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const lines = getLogLines();
  return `=== Diagnostic ===\n${header}\n\n=== Logs (${ring.length}) ===\n${
    lines || "(aucun)"
  }`;
}
