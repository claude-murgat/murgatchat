import { useState } from "react";

export default function DndModal({ active, user, onClose, onPick, onSaveSchedule }) {
  const presets = [
    { label: "30 minutes", minutes: 30 },
    { label: "1 heure", minutes: 60 },
    { label: "2 heures", minutes: 120 },
    { label: "Jusqu'à demain matin", minutes: minutesUntilTomorrow(8) },
    { label: "Toute la semaine", minutes: 60 * 24 * 7 },
  ];

  const [enabled, setEnabled] = useState(!!user?.dndScheduleEnabled);
  const [start, setStart] = useState(user?.dndStart || "22:00");
  const [end, setEnd] = useState(user?.dndEnd || "08:00");
  const [saving, setSaving] = useState(false);

  async function saveSchedule() {
    setSaving(true);
    try {
      await onSaveSchedule({ enabled, start, end });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-full sm:h-auto sm:max-w-md sm:max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-lg font-bold">Ne pas déranger</h2>
          <p className="text-sm text-slate-500">Coupez les notifications pendant…</p>
        </div>
        <div className="py-2">
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => onPick(p.minutes)}
              className="w-full text-left px-5 py-2 hover:bg-slate-100"
            >
              {p.label}
            </button>
          ))}
          {active && (
            <button
              onClick={() => onPick(0)}
              className="w-full text-left px-5 py-2 hover:bg-slate-100 text-red-600"
            >
              Désactiver maintenant
            </button>
          )}
        </div>

        <div className="border-t border-slate-200 p-4 space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Planning quotidien (heures calmes)
          </label>
          <div
            className={`flex items-center gap-2 text-sm ${
              enabled ? "" : "opacity-50"
            }`}
          >
            <span>De</span>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={!enabled}
              className="border border-slate-300 rounded px-2 py-1"
            />
            <span>à</span>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              disabled={!enabled}
              className="border border-slate-300 rounded px-2 py-1"
            />
            <button
              onClick={saveSchedule}
              disabled={saving}
              className="ml-auto bg-aubergine-700 text-white px-3 py-1 rounded font-medium hover:bg-aubergine-800 disabled:opacity-50"
            >
              Enregistrer
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Coupe les notifications chaque jour sur cette plage (heure du serveur).
          </p>
        </div>

        <div className="p-3 border-t border-slate-200 text-right">
          <button onClick={onClose} className="px-3 py-1.5 rounded border">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

function minutesUntilTomorrow(hour) {
  const now = new Date();
  const target = new Date();
  target.setDate(now.getDate() + 1);
  target.setHours(hour, 0, 0, 0);
  return Math.max(1, Math.round((target.getTime() - now.getTime()) / 60_000));
}
