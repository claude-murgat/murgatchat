import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { storeEncryptedAttachment, MAX_UPLOAD_BYTES } from "./uploads.ts";

// GIPHY proxy. The API key lives only on the server (never in the client bundle)
// and is read per-request so deployments can set it without a code change (and
// tests can toggle it). Empty key → endpoints report "not configured" instead of
// leaking a broken provider call.
const GIPHY_BASE = "https://api.giphy.com/v1/gifs";
const PAGE = 24;
const MAX_GIF_BYTES = MAX_UPLOAD_BYTES; // reflète le plafond d'upload (MAX_UPLOAD_MB)

function giphyKey() {
  return process.env.GIPHY_API_KEY || "";
}
function rating() {
  return process.env.GIF_RATING || "pg-13";
}

const router = Router();

// Formes minimales de la réponse GIPHY : uniquement les champs lus ici. Tout
// est optionnel, l'API étant une source externe non validée (les replis `|| {}`
// du code sont la vraie garde d'exécution).
interface GiphyRendition {
  url?: string;
  width?: string;
  height?: string;
}
interface GiphyImages {
  fixed_width?: GiphyRendition;
  downsized?: GiphyRendition;
  downsized_large?: GiphyRendition;
  original?: GiphyRendition;
}
interface GiphyGif {
  id?: string;
  title?: string;
  images?: GiphyImages;
}
interface GiphySearchResponse {
  data?: GiphyGif[];
  pagination?: { offset?: number; count?: number };
}

// Normalize a GIPHY result down to what the client grid needs. `fixed_width` is
// a ~200px-wide animated rendition (cheap for the grid); `original` is what we
// re-host on selection.
function mapGiphy(g: GiphyGif) {
  const img: GiphyImages = g.images || {};
  const preview: GiphyRendition = img.fixed_width || img.downsized || img.original || {};
  const full: GiphyRendition = img.original || img.downsized_large || img.fixed_width || {};
  if (!preview.url || !full.url) return null;
  return {
    id: g.id,
    title: g.title || "",
    previewUrl: preview.url,
    fullUrl: full.url,
    // `width` / `height` restent optionnels côté type ; `parseInt(undefined)`
    // donne NaN, absorbé par le `|| null` — l'assertion préserve ce chemin.
    width: parseInt(full.width as string, 10) || null,
    height: parseInt(full.height as string, 10) || null,
  };
}

router.get("/config", requireAuth, (_req, res) => {
  res.json({ provider: "giphy", configured: !!giphyKey() });
});

// Search (or trending when q is empty). pos = pagination offset.
router.get("/search", requireAuth, async (req, res) => {
  const key = giphyKey();
  if (!key) return res.status(503).json({ error: "not_configured", gifs: [] });

  const q = (req.query.q || "").toString().trim().slice(0, 100);
  const pos = Math.max(0, parseInt((req.query.pos as string) || "0", 10) || 0);
  const endpoint = q ? "search" : "trending";
  const params = new URLSearchParams({
    api_key: key,
    limit: String(PAGE),
    offset: String(pos),
    rating: rating(),
    bundle: "messaging_non_clips",
  });
  if (q) params.set("q", q);

  try {
    const r = await fetch(`${GIPHY_BASE}/${endpoint}?${params.toString()}`);
    if (!r.ok) return res.status(502).json({ error: "provider_error", gifs: [] });
    const data = (await r.json()) as GiphySearchResponse;
    const gifs = (data.data || []).map(mapGiphy).filter(Boolean);
    const p: NonNullable<GiphySearchResponse["pagination"]> = data.pagination || {};
    const nextPos = (p.offset || pos) + (p.count || gifs.length);
    res.json({ gifs, nextPos, provider: "giphy" });
  } catch {
    res.status(502).json({ error: "provider_error", gifs: [] });
  }
});

// Only GIPHY media hosts may be imported — this endpoint fetches a URL
// server-side, so an open target would be an SSRF hole.
function isAllowedGifUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)giphy\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// Re-host the selected GIF: download it from GIPHY and store it as an encrypted
// attachment (same pipeline as uploads), so recipients never hit GIPHY's CDN and
// the GIF can't rot. Returns an attachment shaped exactly like POST /uploads.
router.post("/import", requireAuth, async (req, res) => {
  const url = (req.body || {}).url;
  if (!isAllowedGifUrl(url)) return res.status(400).json({ error: "invalid_gif_url" });

  let buffer, contentType;
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: "fetch_failed" });
    contentType = (r.headers.get("content-type") || "image/gif").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      return res.status(400).json({ error: "not_an_image" });
    }
    const declared = parseInt(r.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_GIF_BYTES) {
      return res.status(413).json({ error: "too_large" });
    }
    buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > MAX_GIF_BYTES) {
      return res.status(413).json({ error: "too_large" });
    }
  } catch {
    return res.status(502).json({ error: "fetch_failed" });
  }

  try {
    const att = await storeEncryptedAttachment(buffer, {
      filename: "giphy.gif",
      mimeType: contentType,
      uploadedBy: req.userId,
    });
    res.json({
      attachment: { id: att.id, filename: att.filename, mimeType: att.mimeType, size: att.size },
    });
  } catch (e) {
    // Assertion plutôt que garde `instanceof Error` : une garde imposerait une
    // branche de repli, donc un comportement d'exécution différent.
    console.error("[gifs] store failed:", (e as Error).message);
    res.status(500).json({ error: "store_failed" });
  }
});

export default router;
