import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import Avatar from "./Avatar.tsx";
import QuickSwitcher from "./QuickSwitcher.tsx";
import { isTauri } from "../desktop.ts";
import { pwaSupported, requestNotificationPermission, isPwaInstalled } from "../pwa.ts";
import type { Channel, User } from "../types.ts";

/** Coordonnées viewport où ouvrir le menu contextuel d'une conversation. */
interface LongPressPosition {
  x: number;
  y: number;
}

/** État du menu contextuel d'une conversation : la cible + où l'afficher. */
interface ConvMenuState extends LongPressPosition {
  channelId: string;
  unread: boolean;
}

/** Ce que le code lit du point de contact (un `Touch`, ou l'évènement en repli). */
interface ClientPoint {
  clientX: number;
  clientY: number;
}

// `beforeinstallprompt` n'est pas décrit par lib.dom : on ne type que les deux
// membres réellement utilisés. L'évènement différé est déposé sur `window`
// (partagé avec InstallPwaBanner) et relu via une vue typée locale, plutôt
// qu'une augmentation globale de Window qui vaudrait pour tout le projet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
type WindowWithInstallPrompt = Window & {
  __deferredInstallPrompt?: BeforeInstallPromptEvent | null;
};

// Appui long (mobile/PWA) + clic droit (desktop) sur une conversation pour
// ouvrir un menu contextuel. Renvoie les gestionnaires à étaler sur l'élément
// ainsi qu'un `onClickCapture` qui neutralise le clic parasite déclenché après
// un appui long (sinon la conversation s'ouvrirait au relâchement du doigt).
function useLongPress(onLongPress: (pos: LongPressPosition) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);
  return {
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        fired.current = false;
        const point = (e.touches?.[0] || e) as ClientPoint;
        const x = point.clientX;
        const y = point.clientY;
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLongPress({ x, y });
        }, 500);
      },
      onTouchEnd: (e: React.TouchEvent) => {
        // Après un appui long, on supprime le clic synthétique du navigateur :
        // sinon il retomberait sur le backdrop du menu et le refermerait aussitôt
        // (et rouvrirait la conversation). onClickCapture reste un garde-fou desktop.
        if (fired.current) e.preventDefault();
        clear();
      },
      onTouchMove: clear,
      onContextMenu: (e: React.MouseEvent) => {
        // Clic droit desktop (et menu natif de certains appuis longs).
        e.preventDefault();
        fired.current = true;
        onLongPress({ x: e.clientX, y: e.clientY });
      },
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}

function dndLabel(user: User) {
  if (!user?.dndUntil) return null;
  const until = new Date(user.dndUntil);
  if (until <= new Date()) return null;
  // `minutes` n'appartient pas à Intl.DateTimeFormatOptions ; l'assertion la
  // laisse passer telle quelle (annotation seule, comportement inchangé).
  return `Ne pas déranger · jusqu'à ${until.toLocaleTimeString([], {
    hour: "2-digit",
    minutes: "2-digit",
  } as Intl.DateTimeFormatOptions)}`;
}

// Timestamp (ms) of a conversation's last message, 0 if it has none yet — used
// to sort the DM list by most-recent activity (#180). A brand-new DM with no
// message sinks to the bottom until something is said in it.
function lastActivity(c: Channel) {
  return c.lastMessage?.createdAt ? new Date(c.lastMessage.createdAt).getTime() : 0;
}

interface SidebarProps {
  user: User;
  channels: Channel[];
  activeChannelId: string | null;
  onSelectChannel: (channel: Channel) => void;
  onMarkUnread?: (channelId: string) => void;
  onMarkRead?: (channelId: string) => void;
  onNewChannel: (name: string) => void;
  onNewDm: () => void;
  onChannelJoined: (channel: Channel) => void;
  onDmOpened: (channel: Channel) => void;
  onToggleDnd: () => void;
  onLogout: () => void;
  onInvite: () => void;
  onProfile: () => void;
  onPreferences: () => void;
  onReportBug: () => void;
  onAdminPanel: () => void;
  onlineUserIds?: Set<string>;
  /** Identifiants des utilisateurs en train d'écrire, par conversation. */
  typingByChannel?: Record<string, string[]>;
}

export default function Sidebar({
  user,
  channels,
  activeChannelId,
  onSelectChannel,
  onMarkUnread,
  onMarkRead,
  onNewChannel,
  onNewDm,
  onChannelJoined,
  onDmOpened,
  onToggleDnd,
  onLogout,
  onInvite,
  onProfile,
  onPreferences,
  onReportBug,
  onAdminPanel,
  onlineUserIds,
  typingByChannel,
}: SidebarProps) {
  const [showMenu, setShowMenu] = useState(false);
  // Menu contextuel d'une conversation (appui long / clic droit) :
  // { channelId, unread, x, y } ou null.
  const [convMenu, setConvMenu] = useState<ConvMenuState | null>(null);
  // Unified search ("quick switcher"): while non-empty, replaces the channel/DM
  // lists with grouped results (your convos + public salons + people + create).
  const [query, setQuery] = useState("");
  // Statut PWA / notifications web. Calculé au montage et après chaque action
  // pour piloter le libellé du menu ("Activer les notifications" vs "Activées").
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const [pwaInstallable, setPwaInstallable] = useState(false);
  const [installed, setInstalled] = useState(isPwaInstalled());
  useEffect(() => {
    function onBeforeInstallPrompt(e: Event) {
      // Chrome / Edge desktop: garde l'événement pour pouvoir le déclencher
      // depuis notre bouton "Installer".
      e.preventDefault();
      (window as WindowWithInstallPrompt).__deferredInstallPrompt =
        e as BeforeInstallPromptEvent;
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
    const evt = (window as WindowWithInstallPrompt).__deferredInstallPrompt;
    if (!evt) return;
    evt.prompt();
    await evt.userChoice;
    (window as WindowWithInstallPrompt).__deferredInstallPrompt = null;
    setPwaInstallable(false);
  }

  const groups = channels.filter((c) => !c.isDirect);
  // DMs sorted by most-recent activity (SMS-style, #180): the conversation with
  // the latest message floats to the top — which also surfaces unread ones,
  // since they're usually the most recent (see the coloured badge below, #179).
  // .filter() returns a fresh array, so sorting it never mutates the channels state.
  const dms = channels
    .filter((c) => c.isDirect)
    .sort((a, b) => lastActivity(b) - lastActivity(a));

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
        {/* Click-outside backdrop: dismisses the user menu (invisible, below the
            menu's z-30 but above everything else). Same idea as the modals. */}
        {showMenu && (
          <div
            className="fixed inset-0 z-20"
            onClick={() => setShowMenu(false)}
            aria-hidden="true"
          />
        )}
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
                onReportBug();
              }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
            >
              🐞 Signaler un bug
            </button>
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

      {/* Unified search — replaces the browse/create channel + DM buttons. */}
      <div className="px-2 pt-3 pb-1 shrink-0">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-aubergine-400 text-sm pointer-events-none">
            🔍
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher ou créer…"
            className="w-full bg-aubergine-800 text-white placeholder-aubergine-400 rounded-md pl-8 pr-8 py-2 text-sm focus:outline-hidden focus:ring-1 focus:ring-slackblue"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-aubergine-400 hover:text-white"
              aria-label="Effacer la recherche"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-2 py-3 space-y-4">
        {query.trim() ? (
          <QuickSwitcher
            query={query}
            user={user}
            channels={channels}
            onSelectChannel={(c) => {
              onSelectChannel(c);
              setQuery("");
            }}
            onJoined={(c) => {
              onChannelJoined(c);
              setQuery("");
            }}
            onOpened={(c) => {
              onDmOpened(c);
              setQuery("");
            }}
            onCreateChannel={(name) => {
              onNewChannel(name);
              setQuery("");
            }}
            onNewGroup={() => {
              onNewDm();
              setQuery("");
            }}
            onlineUserIds={onlineUserIds}
          />
        ) : (
          <>
        <SidebarSection title="Salons">
          {groups.map((c) => (
            <SidebarItem
              key={c.id}
              active={c.id === activeChannelId}
              onClick={() => onSelectChannel(c)}
              onLongPress={(pos) =>
                setConvMenu({ channelId: c.id, unread: c.unread, ...pos })
              }
              prefix={c.isPrivate ? "🔒" : "#"}
              label={c.name || "salon"}
              unread={c.unread}
            />
          ))}
          {groups.length === 0 && (
            <div className="text-xs text-aubergine-400 px-2 py-1">Aucun salon</div>
          )}
        </SidebarSection>

        <SidebarSection title="Messages directs">
          {dms.map((c) => (
            <DmItem
              key={c.id}
              c={c}
              user={user}
              active={c.id === activeChannelId}
              isTyping={(typingByChannel?.[c.id]?.length || 0) > 0}
              onlineUserIds={onlineUserIds}
              onClick={() => onSelectChannel(c)}
              onLongPress={(pos) =>
                setConvMenu({ channelId: c.id, unread: c.unread, ...pos })
              }
            />
          ))}
          {dms.length === 0 && (
            <div className="text-xs text-aubergine-400 px-2 py-1">Aucun DM</div>
          )}
        </SidebarSection>
          </>
        )}
      </div>

      {/* Menu contextuel d'une conversation (appui long / clic droit). Backdrop
          invisible pour fermer au clic extérieur, comme le menu utilisateur. */}
      {convMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setConvMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setConvMenu(null);
            }}
            aria-hidden="true"
          />
          <div
            className="fixed bg-white text-slate-800 rounded-md shadow-lg overflow-hidden z-50 w-56"
            style={{
              left: Math.min(convMenu.x, window.innerWidth - 230),
              top: Math.min(convMenu.y, window.innerHeight - 60),
            }}
          >
            {convMenu.unread ? (
              <button
                onClick={() => {
                  const id = convMenu.channelId;
                  setConvMenu(null);
                  onMarkRead?.(id);
                }}
                className="block w-full text-left px-3 py-2.5 text-sm hover:bg-slate-100"
              >
                Marquer comme lu
              </button>
            ) : (
              <button
                onClick={() => {
                  const id = convMenu.channelId;
                  setConvMenu(null);
                  onMarkUnread?.(id);
                }}
                className="block w-full text-left px-3 py-2.5 text-sm hover:bg-slate-100"
              >
                Marquer comme non lu
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

interface SidebarSectionProps {
  title: string;
  children?: ReactNode;
}

function SidebarSection({ title, children }: SidebarSectionProps) {
  return (
    <div>
      <div className="px-2 mb-1 text-xs uppercase tracking-wide text-aubergine-400">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

interface SidebarItemProps {
  active: boolean;
  onClick: () => void;
  onLongPress?: (pos: LongPressPosition) => void;
  prefix: string;
  label: string;
  unread: boolean;
}

function SidebarItem({ active, onClick, onLongPress, prefix, label, unread }: SidebarItemProps) {
  const { handlers, onClickCapture } = useLongPress(onLongPress || (() => {}));
  return (
    <button
      onClick={onClick}
      onClickCapture={onClickCapture}
      {...handlers}
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
        <span
          className="w-2.5 h-2.5 rounded-full bg-slackred shrink-0 ring-2 ring-slackred/30"
          title="Non lu"
        />
      )}
    </button>
  );
}

interface DmItemProps {
  c: Channel;
  user: User;
  active: boolean;
  isTyping: boolean;
  onlineUserIds?: Set<string>;
  onClick: () => void;
  onLongPress?: (pos: LongPressPosition) => void;
}

function DmItem({ c, user, active, isTyping, onlineUserIds, onClick, onLongPress }: DmItemProps) {
  const { handlers, onClickCapture } = useLongPress(onLongPress || (() => {}));
  const other = c.members.find((m) => m.id !== user.id) || c.members[0];
  const isGroup = c.members.length > 2;
  // Self-DM (notes pour soi): a single membership, that's the viewer.
  const isSelf = c.members.length === 1 && c.members[0]?.id === user.id;
  return (
    <button
      onClick={onClick}
      onClickCapture={onClickCapture}
      {...handlers}
      className={`w-full flex items-center gap-2 px-3 py-2.5 md:py-1.5 rounded text-left text-[15px] md:text-sm ${
        active
          ? "bg-slackblue text-white"
          : c.unread
          ? "text-white font-semibold hover:bg-aubergine-600"
          : "text-aubergine-400 hover:bg-aubergine-600 hover:text-white"
      }`}
    >
      {isTyping ? (
        <span
          className="w-5 h-5 shrink-0 rounded-sm grid place-items-center bg-aubergine-500 text-white text-[11px] font-bold animate-pulse"
          title="En train d'écrire…"
        >
          …
        </span>
      ) : isSelf ? (
        <span
          className="w-5 h-5 shrink-0 rounded-sm grid place-items-center bg-aubergine-500 text-white text-[12px]"
          title="Notes pour vous-même"
        >
          📝
        </span>
      ) : isGroup ? (
        <span
          className="w-5 h-5 shrink-0 rounded-sm grid place-items-center bg-aubergine-500 text-white text-[11px] font-semibold"
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
      {c.unread && !active && (
        <span
          className="w-2.5 h-2.5 rounded-full bg-slackred shrink-0 ring-2 ring-slackred/30"
          title="Non lu"
        />
      )}
    </button>
  );
}
