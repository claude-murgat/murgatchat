import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function BrowseChannelsModal({ onClose, onJoined }) {
  const [channels, setChannels] = useState([]);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.publicChannels(q).then((res) => {
      if (!cancelled) setChannels(res.channels);
    });
    return () => {
      cancelled = true;
    };
  }, [q]);

  async function join(c) {
    setBusyId(c.id);
    try {
      const res = await api.joinChannel(c.id);
      onJoined(res.channel);
      setChannels((prev) => prev.filter((x) => x.id !== c.id));
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4">
      <div className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-xl font-bold">Parcourir les salons</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
            ✕
          </button>
        </div>
        <div className="p-4">
          <input
            autoFocus
            className="w-full border rounded-md px-3 py-2"
            placeholder="Rechercher un salon public..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="px-2 pb-2 overflow-y-auto">
          {channels.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 px-3 py-2 hover:bg-slate-100 rounded-md"
            >
              <span className="text-slate-400 text-lg">#</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.name}</div>
                <div className="text-xs text-slate-500 truncate">
                  {c.members.length} membre{c.members.length > 1 ? "s" : ""}
                  {c.description ? ` · ${c.description}` : ""}
                </div>
              </div>
              <button
                onClick={() => join(c)}
                disabled={busyId === c.id}
                className="text-sm px-3 py-1 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
              >
                Rejoindre
              </button>
            </div>
          ))}
          {channels.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-500">
              Aucun salon public à rejoindre.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
