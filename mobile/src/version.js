import { Platform } from "react-native";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { api } from "./api";

// App version from app.json (Expo bakes it into Constants at build time).
export const LOCAL_VERSION = Constants.expoConfig?.version || "0.0.0";

// Manifeste de la dernière APK publiée, attaché à chaque release par android.yml :
// { version, versionCode, url, size, sha256, md5 }. /releases/latest ne renvoie
// ni brouillon ni pré-release : il n'apparaît qu'une fois la release publiée.
const APK_MANIFEST_URL =
  "https://github.com/claude-murgat/murgatchat/releases/latest/download/android.json";
// Seules les APK des releases de ce dépôt sont téléchargées. Android refuse de
// toute façon une APK qui n'est pas signée avec le même certificat que l'appli.
const APK_URL_PREFIX = "https://github.com/claude-murgat/murgatchat/releases/download/";

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

async function fetchApkManifest() {
  if (Platform.OS !== "android") return null;
  try {
    const res = await fetch(APK_MANIFEST_URL, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) return null;
    const m = await res.json();
    if (typeof m?.version !== "string" || typeof m?.url !== "string") return null;
    if (!m.url.startsWith(APK_URL_PREFIX)) return null;
    return m;
  } catch {
    return null;
  }
}

// Une mise à jour est-elle disponible ? Never throws.
//  - `apk` : l'APK publiée est plus récente que l'appli → installable depuis l'appli ;
//  - sinon, le serveur annonce une version plus récente (CLIENT_VERSION) dont
//    l'APK n'est pas (encore) publiée → simple information.
export async function checkForUpdate() {
  const [apk, server] = await Promise.all([
    fetchApkManifest(),
    api.version().catch(() => null),
  ]);
  if (apk && isNewer(apk.version, LOCAL_VERSION)) {
    return { updateAvailable: true, latest: apk.version, apk };
  }
  if (server?.version && isNewer(server.version, LOCAL_VERSION)) {
    return { updateAvailable: true, latest: server.version, apk: null };
  }
  return { updateAvailable: false, latest: null, apk: null };
}

const APK_FILE_RE = /^Chat_.*\.apk$/;

// Télécharge l'APK du manifeste dans le cache, vérifie son empreinte, puis ouvre
// l'installeur d'Android (« Mettre à jour cette application ? »). La première
// fois, Android demande d'autoriser l'installation d'applis depuis Chat.
// `onProgress(fraction)` : 0 → 1 pendant le téléchargement. Throws on failure.
export async function downloadAndInstallApk(apk, onProgress) {
  const dir = FileSystem.cacheDirectory;
  // Les APK des mises à jour précédentes (~40 Mo chacune) ne servent plus.
  const old = await FileSystem.readDirectoryAsync(dir).catch(() => []);
  await Promise.all(
    old
      .filter((name) => APK_FILE_RE.test(name))
      .map((name) => FileSystem.deleteAsync(dir + name, { idempotent: true }).catch(() => {}))
  );

  const target = `${dir}Chat_${apk.version.replace(/[^0-9A-Za-z.-]/g, "")}.apk`;
  const download = FileSystem.createDownloadResumable(apk.url, target, {}, (p) => {
    const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : apk.size;
    if (total > 0) onProgress?.(Math.min(1, p.totalBytesWritten / total));
  });
  const res = await download.downloadAsync();
  if (!res || res.status !== 200) {
    throw new Error(`téléchargement refusé (HTTP ${res?.status ?? "?"})`);
  }
  if (apk.md5) {
    const info = await FileSystem.getInfoAsync(res.uri, { md5: true });
    if (!info.exists || info.md5 !== apk.md5) {
      await FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => {});
      throw new Error("fichier incomplet ou corrompu");
    }
  }
  // L'installeur lit l'APK par une URI content:// (FileProvider d'expo-file-system).
  const contentUri = await FileSystem.getContentUriAsync(res.uri);
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: "application/vnd.android.package-archive",
  });
}
