import { isTauri } from "../desktop.js";

// Shown at the top of the app when the server advertises a newer version.
// - Web   : the fresh bundle is already served → "Rafraîchir" reloads the page.
// - Desktop: the app is installed → "Télécharger" opens the release page so the
//   user can grab the new installer (refreshing wouldn't change the bundled app).
export default function UpdateBanner({ info, onDismiss }) {
  if (!info?.updateAvailable) return null;
  const desktop = isTauri();

  function action() {
    if (desktop) {
      // Open the release page in the system browser. window.open is the
      // dependency-free path; the URL is also shown below as a fallback.
      try {
        window.open(info.downloadUrl, "_blank", "noopener,noreferrer");
      } catch {
        /* ignore — user can use the visible link */
      }
    } else {
      // Hard reload to pull the freshly-served bundle.
      window.location.reload();
    }
  }

  return (
    <div className="bg-amber-100 border-b border-amber-300 text-amber-900 px-4 py-2 text-sm flex items-center gap-3">
      <span className="font-semibold">Nouvelle version disponible ({info.latest})</span>
      <span className="opacity-80 hidden sm:inline">
        {desktop
          ? "Téléchargez le nouvel installeur pour mettre à jour."
          : "Rafraîchissez la page pour l'utiliser."}
      </span>
      <button
        onClick={action}
        className="ml-auto px-3 py-1 rounded-md bg-amber-600 text-white font-medium hover:bg-amber-700"
      >
        {desktop ? "Télécharger" : "Rafraîchir"}
      </button>
      {desktop && (
        <a
          href={info.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline text-amber-800 break-all hidden md:inline"
        >
          {info.downloadUrl}
        </a>
      )}
      <button
        onClick={onDismiss}
        title="Masquer"
        className="text-amber-700 hover:text-amber-900 px-1"
      >
        ✕
      </button>
    </div>
  );
}
