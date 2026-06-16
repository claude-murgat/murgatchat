import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// GIF search/browse panel (popover). Trending on open, debounced search as you
// type. Clicking a GIF calls onSelect(gif) — the Composer imports + sends it.
// Thumbnails load straight from GIPHY's CDN (only the chosen GIF is re-hosted).
export default function GifPicker({ onSelect }) {
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [nextPos, setNextPos] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  async function load(query, pos, append) {
    const s = ++seq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.gifSearch({ q: query, pos });
      if (s !== seq.current) return;
      setNotConfigured(false);
      setGifs((prev) => (append ? [...prev, ...res.gifs] : res.gifs));
      setNextPos(res.nextPos || 0);
      setHasMore((res.gifs?.length || 0) >= 24);
    } catch (e) {
      if (s !== seq.current) return;
      if (e?.data?.error === "not_configured") {
        setNotConfigured(true);
        setGifs([]);
      } else {
        setError("GIF indisponibles pour le moment.");
      }
    } finally {
      if (s === seq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  // Trending on mount + debounced reload on query change.
  useEffect(() => {
    const t = setTimeout(() => load(q.trim(), 0, false), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="w-80 max-w-[92vw] h-96 bg-white border border-slate-200 rounded-lg shadow-xl flex flex-col overflow-hidden">
      <div className="p-2 border-b border-slate-200">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher un GIF…"
          className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-aubergine-400"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading && <div className="text-center text-sm text-slate-400 py-6">Chargement…</div>}
        {notConfigured && (
          <div className="text-center text-sm text-slate-500 px-4 py-6">
            Recherche de GIF non configurée.
            <span className="block text-xs text-slate-400 mt-1">
              Définissez <code>GIPHY_API_KEY</code> côté serveur.
            </span>
          </div>
        )}
        {error && !loading && (
          <div className="text-center text-sm text-red-500 py-6">{error}</div>
        )}
        {!loading && !error && !notConfigured && gifs.length === 0 && (
          <div className="text-center text-sm text-slate-400 py-6">Aucun résultat.</div>
        )}

        {gifs.length > 0 && (
          <div className="columns-2 gap-2">
            {gifs.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelect(g)}
                className="block w-full mb-2 break-inside-avoid rounded overflow-hidden bg-slate-100 hover:ring-2 hover:ring-aubergine-400 focus:outline-none focus:ring-2 focus:ring-aubergine-400"
                title={g.title || "GIF"}
              >
                <img src={g.previewUrl} alt={g.title || "GIF"} loading="lazy" className="w-full" />
              </button>
            ))}
          </div>
        )}

        {hasMore && !loading && (
          <div className="text-center pt-1">
            <button
              type="button"
              onClick={() => load(q.trim(), nextPos, true)}
              disabled={loadingMore}
              className="px-3 py-1.5 text-sm rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            >
              {loadingMore ? "Chargement…" : "Voir plus"}
            </button>
          </div>
        )}
      </div>

      <div className="px-2 py-1 border-t border-slate-200 text-[10px] uppercase tracking-wide text-slate-400 text-center">
        Powered by GIPHY
      </div>
    </div>
  );
}
