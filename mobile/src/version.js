import Constants from "expo-constants";
import { api } from "./api";

// App version from app.json (Expo bakes it into Constants at build time).
export const LOCAL_VERSION = Constants.expoConfig?.version || "0.0.0";

function parts(v) {
  return String(v || "0")
    .split("-")[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

export function isNewer(remote, local) {
  const a = parts(remote);
  const b = parts(local);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Ask the server for the published version. Never throws.
export async function checkForUpdate() {
  try {
    const { version } = await api.version();
    return { updateAvailable: isNewer(version, LOCAL_VERSION), latest: version };
  } catch {
    return null;
  }
}
