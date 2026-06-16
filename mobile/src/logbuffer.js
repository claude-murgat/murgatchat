// In-memory diagnostic log buffer for bug reports (React Native / Expo).
//
// Mirrors web/src/logbuffer.js: captures console.warn/error + explicit app
// breadcrumbs into a bounded ring, plus a diagnostic header (version, platform,
// device, server URL, socket state). Context that would create an import cycle
// (server URL, current user, socket state) is pushed in via setLogContext().
//
// PRIVACY: never stores message bodies — events and IDs only.

import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";

const MAX_ENTRIES = 300;
const MAX_LINE = 1000;

const ring = [];
let installed = false;
let context = {}; // { userId, username, serverUrl, socket }

const APP_VERSION = Constants.expoConfig?.version || "0.0.0";

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

export function logEvent(level, ...args) {
  push(level, fmt(args));
}
export const logInfo = (...a) => logEvent("info", ...a);
export const logWarn = (...a) => logEvent("warn", ...a);
export const logError = (...a) => logEvent("error", ...a);

export function setLogContext(patch) {
  context = { ...context, ...patch };
}

export function installLogCapture() {
  if (installed) return;
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

  // Capture uncaught JS errors via RN's global handler, chaining the previous one.
  try {
    const G = global;
    if (G?.ErrorUtils?.getGlobalHandler && G.ErrorUtils.setGlobalHandler) {
      const prev = G.ErrorUtils.getGlobalHandler();
      G.ErrorUtils.setGlobalHandler((err, isFatal) => {
        push("error", `global ${isFatal ? "fatal " : ""}error: ${err?.message || err}`);
        if (prev) prev(err, isFatal);
      });
    }
  } catch {
    /* ignore */
  }

  logInfo(`diagnostic capture started · ${Platform.OS} · v${APP_VERSION}`);
}

export function getDiagnostics(extra = {}) {
  const out = {
    appVersion: APP_VERSION,
    platform: Platform.OS, // "android" | "ios"
    osVersion: String(Platform.Version),
    device: [Device.manufacturer, Device.modelName].filter(Boolean).join(" "),
    serverUrl: context.serverUrl,
    userId: context.userId,
    username: context.username,
    socket: context.socket,
    time: new Date().toISOString(),
    ...extra,
  };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") delete out[k];
  }
  return out;
}

export function getLogLines() {
  return ring
    .map((e) => `${new Date(e.t).toISOString()} [${e.level}] ${e.msg}`)
    .join("\n");
}

export function entryCount() {
  return ring.length;
}

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
