import fs from "node:fs";
import path from "node:path";

// Single source of truth for the upload directory used by both the upload
// route and the orphan-sweep worker. Keeping `process.env` read at module load
// (rather than per call) matches `uploads.js` and avoids surprises in tests
// where the env is set before any import.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";

// Resolve a stored filename (the random hex name kept in Attachment.storagePath)
// into an absolute path inside UPLOAD_DIR. Returns null if `storagePath` looks
// like a traversal attempt — extra paranoia for a string that shouldn't contain
// separators in practice.
export function uploadPath(storagePath) {
  if (!storagePath || storagePath.includes("/") || storagePath.includes("\\") || storagePath.includes("..")) {
    return null;
  }
  return path.join(UPLOAD_DIR, storagePath);
}

// Best-effort delete. Returns true if a file was removed, false if it was
// already gone or the path was rejected. Never throws on a missing file — the
// caller would just have to swallow ENOENT itself.
export async function safeUnlink(storagePath) {
  const p = uploadPath(storagePath);
  if (!p) return false;
  try {
    await fs.promises.unlink(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    console.warn(`[storage] unlink failed for ${storagePath}: ${e.message}`);
    return false;
  }
}

export async function listStoredFiles() {
  try {
    return await fs.promises.readdir(UPLOAD_DIR);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// Age in ms since last modification, or -1 if the file is gone. Used by the
// sweep worker to leave in-flight uploads alone (mtime ≈ upload completion).
export async function fileAgeMs(storagePath, { now = Date.now() } = {}) {
  const p = uploadPath(storagePath);
  if (!p) return -1;
  try {
    const st = await fs.promises.stat(p);
    return now - st.mtimeMs;
  } catch {
    return -1;
  }
}
