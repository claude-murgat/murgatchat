import { useState, useEffect } from "react";
import Avatar from "./Avatar.jsx";
import { isTauri } from "../desktop.js";
import { pwaSupported, requestNotificationPermission, isPwaInstalled } from "../pwa.js";

function dndLabel(user) {
  if (!user?.dndUntil) return null;
  const until = new Date(user.dndUntil);
  if (until <= new Date()) return null;
  return `Ne pas déranger · jusqu'à ${until.toLocaleTimeString([], {
    hour: "2-digit",
    minutes: "2-digit",
  })}`;
}

export default function Sidebar({
  user,
  channels,
  activeChannelId,
  onSelectChannel,
  onNewChannel,
  onNewDm,
  onToggleDnd,
  onLogout,
  onInvite,
  onProfile,
  onPreferences,
  onAdminPanel,
  onSearch,
  onBrowseChannels,
  onlineUserIds,
  typingByChannel,
}) {
  const [showMenu, setShowMenu] = useState(false);
  // Statut PWA / notifications web. Calculé au montage et après chaque action
  // pour piloter le libellé du menu ("Activer les notifications" vs "Activées").
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const [pwaInstallable, setPwaInstallable] = useState(false);
  const [installed, setInstalled] = useState(isPwaInstalled());
  useEffect(() => {
    function onBeforeInstallPrompt(e) {
      // Chrome / Edge desktop: garde l'événement pour pouvoir le déclencher
      // depuis notre bouton "Installer".
      e.preventDefault();
      window.__deferredInstallPrompt = e;
      setPwaInstallable(true);
    }
    function onInstalled() {
      setInstalled(true);
      setPwaInstallable(false);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function enableNotifs() {
    const r = await requestNotificationPermission();
    setNotifPerm(typeof Notification !== "undefined" ? Notification.permission : "default");
    if (!r.ok) {
      if (r.reason === "denied") {
        alert(
          "Les notifications ont été refusées. Activez-les dans les réglages du navigateur (icône cadenas → Notifications) pour réessayer."
        );
      } else if (r.reason === "unsupported") {
        alert("Votre navigateur ne supporte pas les notifications push.");
      }
    }
  }

  async function installPwa() {
    const evt = window.__deferredInstallPrompt;
    if (!evt) return;
    evt.prompt();
    await evt.userChoice;
    window.__deferredInstallPrompt = null;
    setPwaInstallable(false);
  }

  const groups = channels.filter((c) => !c.isDirect);
  const dms = channels.filter((c) => c.isDirect);

  const dnd = dndLabel(user);

  return (
    <aside className="bg-aubergine-700 text-white w-full md:w-72 md:shrink-0 flex flex-col h-full">
      <div
        className="px-4 py-3 border-b border-aubergine-600 flex items-center justify-between relative"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div>
          <div className="font-bold text-lg leading-tight">Chat Workspace</div>
          <button
            onClick={() => setShowMenu((s) => !s)}
            className="text-xs text-aubergine-400 hover:text-white flex items-center gap-1"
          >
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            {user.displayName} <span>▾</span>
          </button>
          {dnd && <div className="text-[11px] text-yellow-300 mt-0.5">{dnd}</div>}
        </div>
        <button
          type="button"
          onClick={onSearch}
          title="Rechercher (Ctrl+K)"
          className="text-aubergine-400 hover:text-white text-xl w-11 h-11 grid place-items-center rounded hover:bg-aubergine-600"
          aria-label="Rechercher"
        >
          🔍
        </button>
        {showMenu && (
          <div className="absolute right-3 top-14 bg-white text-slate-800 rounded-md shadow-lg overflow-hidden z-30 w-56">
            <button
              onClick={() => {
                setShowMenu(false);
                onProfile();
              }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
            >
              Mon profil
            </button>
            {user.isAdmin && (
              <button
                onClick={() => {
                  setShowMenu(false);
                  onInvite();
                }}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
              >
                Inviter un utilisateur
              </button>
            )}
            {user.isAdmin && (
              <button
                onClick={() => {
                  setShowMenu(false);
                  onAdminPanel();
                }}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
              >
                Administration
              </button>
            )}
            <button
              onClick={() => {
                setShowMenu(false);
                onToggleDnd();
              }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
            >
              {user.dndUntil && new Date(user.dndUntil) > new Date()
                ? "Désactiver Ne pas déranger"
                : "Activer Ne pas déranger"}
            </button>
            {/* PWA: bouton pour demander la permission notifs (idempotent — disparaît
                une fois accordée). En navigateur uniquement (Tauri a son propre flow). */}
            {!isTauri() && pwaSupported() && notifPerm !== "granted" && (
              <button
                onClick={() => {
                  setShowMenu(false);
                  enableNotifs();
                }}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
              >
                🔔 Activer les notifications
              </button>
            )}
            {/* PWA: déclencher l'install prompt (Chrome/Edge desktop, Android Chrome).
                Sur iOS Safari il n'y a pas d'événement — l'utilisateur doit faire
                "Partager → Ajouter à l'écran d'accueil" à la main. */}
            {!isTauri() && pwaInstallable && !installed && (
              <button
                onClick={() => {
                  setShowMenu(false);
                  installPwa();
                }}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
              >
                📱 Installer l'application
              </button>
            )}
            {isTauri() && (
              <button
                onClick={() => {
                  setShowMenu(false);
                  onPreferences();
                }}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
              >
                Préférences
              </button>
            )}
            <button
              onClick={() => {
                setShowMenu(false);
                onLogout();
              }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-red-600"
            >
              Se déconnecter
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-2 py-3 space-y-4">
        <SidebarSection title="Salons" onAdd={onNewChannel} onBrowse={onBrowseChannels}>
          {groups.map((c) => (
            <SidebarItem
              key={c.id}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c)}
              prefix={c.isPrivate ? "🔒" : "#"}
              label={c.name || "salon"}
              unread={c.unread}
            />
          ))}
          {groups.length === 0 && (
            <div className="text-xs text-aubergine-400 px-2 py-1">Aucun salon</div>
          )}
        </SidebarSection>

        <SidebarSection title="Messages directs" onAdd={onNewDm}>
          {dms.map((c) => {
            const other = c.members.find((m) => m.id !== user.id) || c.members[0];
            const isGroup = c.members.length > 2;
            // Self-DM (notes pour soi): a single membership, that's the viewer.
            const isSelf = c.members.length === 1 && c.members[0]?.id === user.id;
            const isTyping = (typingByChannel?.[c.id]?.length || 0) > 0;
            return (
              <button
                key={c.id}
                onClick={() => onSelectChannel(c)}
                className={`w-full flex items-center gap-2 px-3 py-2.5 md:py-1.5 rounded text-left text-[15px] md:text-sm ${
                  c.id === activeChannelId
                    ? "bg-slackblue text-white"
                    : c.unread
                    ? "text-white font-semibold hover:bg-aubergine-600"
                    : "text-aubergine-400 hover:bg-aubergine-600 hover:text-white"
                }`}
              >
                {isTyping ? (
                  <span
                    className="w-5 h-5 shrink-0 rounded grid place-items-center bg-aubergine-500 text-white text-[11px] font-bold animate-pulse"
                    title="En train d'écrire…"
                  >
                    …
                  </span>
                ) : isSelf ? (
                  <span
                    className="w-5 h-5 shrink-0 rounded grid place-items-center bg-aubergine-500 text-white text-[12px]"
                    title="Notes pour vous-même"
                  >
                    📝
                  </span>
                ) : isGroup ? (
                  <span
                    className="w-5 h-5 shrink-0 rounded grid place-items-center bg-aubergine-500 text-white text-[11px] font-semibold"
                    title={`Groupe · ${c.members.length} personnes`}
                  >
                    {c.members.length}
                  </span>
                ) : (
                  <Avatar user={other} size={20} />
                )}
                {!isGroup && !isSelf && (
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      onlineUserIds?.has(other?.id) ? "bg-green-400" : "bg-slate-500"
                    }`}
                    title={onlineUserIds?.has(other?.id) ? "En ligne" : "Hors ligne"}
                  />
                )}
                <span className="truncate flex-1">{c.displayName || "DM"}</span>
                {c.unread && c.id !== activeChannelId && (
                  <span className="w-2 h-2 rounded-full bg-white shrink-0" />
                )}
              </button>
            );
          })}
          {dms.length === 0 && (
            <div className="text-xs text-aubergine-400 px-2 py-1">Aucun DM</div>
          )}
        </SidebarSection>
      </div>
    </aside>
  );
}

function SidebarSection({ title, onAdd, onBrowse, children }) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 mb-1 text-xs uppercase tracking-wide text-aubergine-400">
        <span>{title}</span>
        <div className="flex items-center gap-1.5">
          {onBrowse && (
            <button
              onClick={onBrowse}
              className="hover:text-white text-[11px]"
              title="Parcourir les salons publics"
            >
              🔍
            </button>
          )}
          <button
            onClick={onAdd}
            className="hover:text-white"
            title={`Ajouter — ${title}`}
          >
            +
          </button>
        </div>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function SidebarItem({ active, onClick, prefix, label, unread }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 md:py-1.5 rounded flex items-center gap-2 text-[15px] md:text-sm ${
        active
          ? "bg-slackblue text-white"
          : unread
          ? "text-white font-semibold hover:bg-aubergine-600"
          : "text-aubergine-400 hover:bg-aubergine-600 hover:text-white"
      }`}
    >
      <span className="opacity-80">{prefix}</span>
      <span className="truncate flex-1">{label}</span>
      {unread && !active && (
        <span className="w-2 h-2 rounded-full bg-white shrink-0" />
      )}
    </button>
  );
}
