import { api } from "./api.js";

// Version baked at build time (see vite.config.js `define`). Guarded so a stray
// runtime (e.g. a test without the define) doesn't throw a ReferenceError.
export const LOCAL_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

// Parse "1.2.3" / "1.2.3-rc.1" → [1,2,3] (suffix ignored — alpha cadence).
function parts(v) {
  return String(v || "0")
    .split("-")[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

// True if `remote` is strictly greater than `local` (major→minor→patch).
export function isNewer(remote, local) {
  const a = parts(remote);
  const b = parts(local);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Ask the server for the published version. Returns
// { updateAvailable, latest, downloadUrl } or null if the check fails (offline,
// old server without /version, etc. — never throws to the caller).
export async function checkForUpdate() {
  try {
    const { version, downloadUrl } = await api.version();
    return {
      updateAvailable: isNewer(version, LOCAL_VERSION),
      latest: version,
      downloadUrl,
    };
  } catch {
    return null;
  }
}
