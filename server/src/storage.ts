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
export function uploadPath(storagePath: string): string | null {
  if (!storagePath || storagePath.includes("/") || storagePath.includes("\\") || storagePath.includes("..")) {
    return null;
  }
  return path.join(UPLOAD_DIR, storagePath);
}

// Best-effort delete. Returns true if a file was removed, false if it was
// already gone or the path was rejected. Never throws on a missing file — the
// caller would just have to swallow ENOENT itself.
export async function safeUnlink(storagePath: string): Promise<boolean> {
  const p = uploadPath(storagePath);
  if (!p) return false;
  try {
    await fs.promises.unlink(p);
    return true;
  } catch (e) {
    // `e` est `unknown` : on le lit via une assertion plutôt qu'une garde
    // `instanceof Error`, parce qu'une garde imposerait une branche de repli
    // (donc un comportement d'exécution différent) là où le code d'origine lit
    // simplement `.code` / `.message`. Les rejets de `fs.promises` sont
    // toujours des `ErrnoException`.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    console.warn(`[storage] unlink failed for ${storagePath}: ${(e as Error).message}`);
    return false;
  }
}

export async function listStoredFiles(): Promise<string[]> {
  try {
    return await fs.promises.readdir(UPLOAD_DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

// Age in ms since last modification, or -1 if the file is gone. Used by the
// sweep worker to leave in-flight uploads alone (mtime ≈ upload completion).
export async function fileAgeMs(
  storagePath: string,
  { now = Date.now() }: { now?: number } = {}
): Promise<number> {
  const p = uploadPath(storagePath);
  if (!p) return -1;
  try {
    const st = await fs.promises.stat(p);
    return now - st.mtimeMs;
  } catch {
    return -1;
  }
}
