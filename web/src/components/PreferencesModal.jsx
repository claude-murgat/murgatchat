import { useEffect, useState } from "react";

// Desktop (Tauri) preferences. Today: launch-at-startup. Structured as sections
// so future options (theme, notifications, etc.) can be added here. The autostart
// plugin is imported lazily so the browser build never pulls it in.
export default function PreferencesModal({ onClose }) {
  const [autostart, setAutostart] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    import("@tauri-apps/plugin-autostart")
      .then((m) => m.isEnabled())
      .then((on) => {
        if (!cancelled) setAutostart(!!on);
      })
      .catch(() => {
        if (!cancelled) {
          setAutostart(false);
          setError("Réglage indisponible sur cette plateforme.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleAutostart(next) {
    setBusy(true);
    setError(null);
    try {
      const m = await import("@tauri-apps/plugin-autostart");
      if (next) await m.enable();
      else await m.disable();
      setAutostart(!!(await m.isEnabled())); // re-read the OS truth
    } catch {
      setError("Échec — réessayez.");
      try {
        const m = await import("@tauri-apps/plugin-autostart");
        setAutostart(!!(await m.isEnabled()));
      } catch {
        /* leave previous value */
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200">
          <h2 className="text-lg font-bold">Préférences</h2>
          <p className="text-sm text-slate-500">Réglages de l'application sur cet ordinateur.</p>
        </div>

        <div className="p-5 space-y-5">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Démarrage
            </h3>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!autostart}
                disabled={autostart === null || busy}
                onChange={(e) => toggleAutostart(e.target.checked)}
              />
              <span>
                <span className="font-medium">Lancer Chat au démarrage de l'ordinateur</span>
                <span className="block text-[12px] text-slate-500">
                  L'application se lance à l'ouverture de session, en arrière-plan (dans la
                  zone de notification).
                </span>
              </span>
            </label>
            {autostart === null && (
              <p className="text-[12px] text-slate-400 mt-1">Chargement…</p>
            )}
            {error && <p className="text-[12px] text-red-600 mt-1">{error}</p>}
          </section>
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
