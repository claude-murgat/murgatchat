import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// Anti-stale-response: a slow debounced fetch must not overwrite the screen
// after the user has already moved on to a newer query.
export default function SearchModal({ onClose, onJump }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [touched, setTouched] = useState(false);
  const seqRef = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setTouched(true);
    const seq = ++seqRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.search({ q: term });
        if (seq !== seqRef.current) return;
        setResults(res.results || []);
        setError(null);
      } catch (e) {
        if (seq === seqRef.current) setError(e.message || "Erreur");
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-start z-50 p-4 pt-16" onClick={onClose}>
      <div
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-200 flex items-center gap-2">
          <span className="text-slate-400">🔍</span>
          <input
            ref={inputRef}
            className="flex-1 outline-none text-base"
            placeholder="Rechercher dans toutes vos conversations…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-slate-500 hover:text-slate-900 px-2"
          >
            Esc
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-4 text-sm text-slate-500">Recherche…</div>}
          {error && <div className="p-3 text-sm text-red-600">{error}</div>}
          {!loading && touched && results.length === 0 && q.trim() && (
            <div className="p-5 text-sm text-slate-500">Aucun résultat.</div>
          )}
          <ul className="divide-y divide-slate-100">
            {results.map((r) => {
              const channelLabel = r.channel?.isDirect
                ? `@${r.author?.username || "?"}`
                : `#${r.channel?.name || "?"}`;
              const when = r.createdAt ? new Date(r.createdAt).toLocaleString() : "";
              return (
                <li key={r.id} className="p-3 hover:bg-slate-50">
                  <button
                    type="button"
                    onClick={() => onJump?.(r)}
                    className="w-full text-left"
                  >
                    <div className="flex items-baseline gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">{channelLabel}</span>
                      <span>·</span>
                      <span>{r.author?.displayName || "?"}</span>
                      <span>·</span>
                      <span>{when}</span>
                    </div>
                    <div
                      className="text-sm text-slate-900 mt-1 [&_mark]:bg-yellow-200 [&_mark]:text-slate-900 [&_mark]:rounded-sm [&_mark]:px-0.5"
                      // ts_headline returns server-trusted snippet with safe markers
                      dangerouslySetInnerHTML={{ __html: r.snippet || "" }}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="p-3 border-t border-slate-200 text-xs text-slate-500">
          La recherche est limitée à vos conversations actuelles. Indexée par Postgres.
        </div>
      </div>
    </div>
  );
}
