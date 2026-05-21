export default function DndModal({ active, onClose, onPick }) {
  const presets = [
    { label: "30 minutes", minutes: 30 },
    { label: "1 heure", minutes: 60 },
    { label: "2 heures", minutes: 120 },
    { label: "Jusqu'à demain matin", minutes: minutesUntilTomorrow(8) },
    { label: "Toute la semaine", minutes: 60 * 24 * 7 },
  ];
  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-lg font-bold">Ne pas déranger</h2>
          <p className="text-sm text-slate-500">
            Coupez les notifications pendant…
          </p>
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
