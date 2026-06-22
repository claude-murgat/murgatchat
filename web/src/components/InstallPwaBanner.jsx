import { useEffect, useState } from "react";
import { isTauri } from "../desktop.js";
import { isPwaInstalled } from "../pwa.js";

// Invite mobile-web users (not the installed PWA, not the desktop app) to add
// Chat to their home screen — mainly so they get push notifications. Dismissible
// and remembered. Sits at the bottom on mobile (order-last, like the update
// banner). NOT gated on pwaSupported(): iOS Safari reports no PushManager until
// the PWA is installed, which is exactly the case we want to prompt.
const DISMISS_KEY = "pwa_install_dismissed";
const MOBILE_MQ = "(max-width: 767px)";

function isIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ masquerades as macOS → fall back to a touch check.
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

export default function InstallPwaBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(MOBILE_MQ)?.matches
  );
  const [installable, setInstallable] = useState(
    () => typeof window !== "undefined" && !!window.__deferredInstallPrompt
  );
  const [installed, setInstalled] = useState(isPwaInstalled());

  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE_MQ);
    const onMq = (e) => setMobile(e.matches);
    mq?.addEventListener?.("change", onMq);
    // Chrome/Android fires this when the app becomes installable → show the button.
    const onPrompt = () => setInstallable(true);
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      mq?.removeEventListener?.("change", onMq);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (isTauri() || installed || dismissed || !mobile) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode — just hide for this session */
    }
    setDismissed(true);
  }

  async function install() {
    const evt = window.__deferredInstallPrompt;
    if (!evt) return;
    evt.prompt();
    await evt.userChoice.catch(() => {});
    window.__deferredInstallPrompt = null;
    setInstallable(false);
  }

  const ios = isIos();

  return (
    <div
      className="order-last bg-aubergine-800 text-white px-4 py-3 text-sm flex items-center gap-3"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <span className="text-xl shrink-0" aria-hidden>
        📲
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold leading-tight">Installez Chat sur votre téléphone</div>
        <div className="text-white/80 text-[13px] leading-snug">
          {ios
            ? "Appuyez sur Partager, puis « Sur l'écran d'accueil » — pour les notifications et un accès direct."
            : "Ajoutez-la à votre écran d'accueil — pour les notifications et un accès direct."}
        </div>
      </div>
      {!ios && installable && (
        <button
          onClick={install}
          className="px-3 py-1.5 rounded-md bg-white text-aubergine-800 font-semibold shrink-0"
        >
          Installer
        </button>
      )}
      <button
        onClick={dismiss}
        title="Masquer"
        aria-label="Masquer"
        className="text-white/70 hover:text-white px-1 text-lg leading-none shrink-0"
      >
        ✕
      </button>
    </div>
  );
}
