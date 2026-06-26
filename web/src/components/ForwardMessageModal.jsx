import { useState } from "react";

// Sélecteur de conversation pour transférer un message (issue #124). On réutilise
// la liste des conversations déjà chargée côté App (aucune requête réseau) et on
// délègue l'envoi à ChannelView via `onPick`. La recherche est insensible à la
// casse et aux accents, comme le QuickSwitcher de la barre latérale.
function previewSnippet(body, max = 80) {
  const flat = (body || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export default function ForwardMessageModal({ message, channels, onClose, onPick }) {
  const [q, setQ] = useState("");

  const norm = (s) =>
    (s || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const ql = norm(q.trim());
  const visible = channels.filter((c) =>
    norm(c.isDirect ? c.displayName : c.name).includes(ql)
  );

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Transférer le message"
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-md sm:max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold">Transférer le message</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-2">
          <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
            <div className="text-xs font-semibold text-slate-500 mb-0.5">
              {message.author?.displayName || "?"}
            </div>
            <div className="truncate">
              {previewSnippet(message.body) || <em>(pièce jointe)</em>}
            </div>
          </div>
          <input
            autoFocus
            className="w-full border rounded-md px-3 py-2"
            placeholder="Rechercher une conversation..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="px-2 pb-3 overflow-y-auto flex-1">
          {visible.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-slate-100"
            >
              <span className="opacity-70 w-5 text-center shrink-0">
                {c.isDirect ? "💬" : c.isPrivate ? "🔒" : "#"}
              </span>
              <span className="flex-1 min-w-0 truncate text-sm">
                {(c.isDirect ? c.displayName : c.name) || "conversation"}
              </span>
            </button>
          ))}
          {visible.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">
              Aucune conversation trouvée
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
