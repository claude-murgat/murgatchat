import { useEffect, useState, useCallback, useRef } from "react";
import { api, getToken, setToken } from "./api.js";
import { getSocket, closeSocket } from "./socket.js";
import {
  notify,
  isWindowFocused,
  ensureReady,
  setTrayBadge,
  isAppHidden,
  isTauri,
  checkDesktopUpdate,
  installDesktopUpdate,
} from "./desktop.js";
import { ensurePwaReady, unsubscribePush, resubscribeIfNeeded } from "./pwa.js";
import Login from "./components/Login.jsx";
import Sidebar from "./components/Sidebar.jsx";
import ChannelView from "./components/ChannelView.jsx";
import NewChannelModal from "./components/NewChannelModal.jsx";
import NewDmModal from "./components/NewDmModal.jsx";
import AddMembersModal from "./components/AddMembersModal.jsx";
import MembersModal from "./components/MembersModal.jsx";
import DndModal from "./components/DndModal.jsx";
import InviteModal from "./components/InviteModal.jsx";
import ProfileModal from "./components/ProfileModal.jsx";
import AdminPanelModal from "./components/AdminPanelModal.jsx";
import PreferencesModal from "./components/PreferencesModal.jsx";
import BugReportModal from "./components/BugReportModal.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import InstallPwaBanner from "./components/InstallPwaBanner.jsx";
import { checkForUpdate } from "./version.js";
import { setLogContext, logEvent } from "./logbuffer.js";

// Per-user memory of the last conversation actually viewed, so every client
// (web / desktop / PWA) reopens straight into it instead of the first channel.
// Keyed by user id so two accounts on one device don't cross over. Wrapped in
// try/catch because localStorage throws in private mode / when storage is full.
const LAST_CHANNEL_PREFIX = "murgat:lastChannel:";
function loadLastChannelId(userId) {
  if (!userId || typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LAST_CHANNEL_PREFIX + userId) || null;
  } catch {
    return null;
  }
}
function saveLastChannelId(userId, channelId) {
  if (!userId || !channelId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LAST_CHANNEL_PREFIX + userId, channelId);
  } catch {
    // Non-fatal: the app just won't remember the last channel on this device.
  }
}

export default function App() {
  const [user, setUser] = useState(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [channels, setChannels] = useState([]);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [socket, setSocket] = useState(null);
  const [showNewChannel, setShowNewChannel] = useState(false);
  // Pre-fills the create-channel modal name when launched from the search field.
  const [newChannelName, setNewChannelName] = useState("");
  const [showNewDm, setShowNewDm] = useState(false);
  const [showDnd, setShowDnd] = useState(false);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [toast, setToast] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [dismissedVersion, setDismissedVersion] = useState(null);
  const [onlineUserIds, setOnlineUserIds] = useState(() => new Set());
  const [typingByChannel, setTypingByChannel] = useState({});
  const typingTimers = useRef({});
  const activeChannelIdRef = useRef(null);
  // Tracks whether a History sentinel is pushed for the open conversation, so the
  // phone's back button closes it instead of leaving the app (mobile layout only).
  const backSentinelRef = useRef(false);
  // Tracks whether the cold-start History guard has been seeded (see effect below).
  const historyGuardRef = useRef(false);
  // The Tauri Update object from the last desktop update check (installed on demand).
  const desktopUpdateRef = useRef(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setBootstrapped(true);
      return;
    }
    api
      .me()
      .then((res) => setUser(res.user))
      .catch(() => setToken(null))
      .finally(() => setBootstrapped(true));
  }, []);

  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
    // Persist the last viewed conversation (never the null "back to list" state
    // on mobile, so the next launch still reopens the real conversation).
    if (user && activeChannelId) saveLastChannelId(user.id, activeChannelId);
  }, [activeChannelId, user]);

  // Keep the diagnostic context (used by bug reports) in sync with the server
  // address and the signed-in user, so a report carries the right header.
  useEffect(() => {
    setLogContext({
      serverUrl: api.url,
      userId: user?.id,
      username: user?.username,
    });
    if (user) logEvent("info", `signed in as @${user.username}`);
  }, [user]);

  // Version check (web/PWA only): the server advertises the published version;
  // if newer, the banner offers a cache-busting refresh. Desktop uses the Tauri
  // updater instead (effect below). Runs on mount, on focus, and every 15 min.
  useEffect(() => {
    if (!user || isTauri()) return;
    let cancelled = false;
    const run = () =>
      checkForUpdate().then((info) => {
        if (!cancelled && info?.updateAvailable) setUpdateInfo(info);
      });
    run();
    const onFocus = () => run();
    window.addEventListener("focus", onFocus);
    const iv = setInterval(run, 15 * 60_000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      clearInterval(iv);
    };
  }, [user]);

  // Desktop (Tauri): auto-update via the updater plugin. On launch, check the
  // signed GitHub release endpoint; if a newer version exists, surface the SAME
  // banner with an "Installer" action (download + install + relaunch).
  useEffect(() => {
    if (!user || !isTauri()) return;
    let cancelled = false;
    checkDesktopUpdate().then((update) => {
      if (cancelled || !update) return;
      desktopUpdateRef.current = update;
      setUpdateInfo({ updateAvailable: true, latest: update.version });
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const token = getToken();
    const s = getSocket(token);
    setSocket(s);
    api.listChannels().then((res) => {
      setChannels(res.channels);
      setActiveChannelId((curr) => {
        if (curr) return curr; // a deep-link / explicit pick already won
        const saved = loadLastChannelId(user.id);
        if (saved && res.channels.some((c) => c.id === saved)) return saved;
        return res.channels[0]?.id || null;
      });
    });

    const onNew = (msg) => {
      setChannels((prev) =>
        prev.map((c) => {
          if (c.id !== msg.channelId) return c;
          const isActive = activeChannelIdRef.current === c.id;
          const fromMe = msg.author?.id === user.id;
          let unread = c.unread;
          if (isActive) unread = false;
          else if (!fromMe) unread = true;
          return {
            ...c,
            lastMessage: {
              id: msg.id,
              body: msg.body,
              createdAt: msg.createdAt,
              authorId: msg.author?.id,
            },
            unread,
          };
        })
      );
    };
    const onCreated = (channel) => {
      setChannels((prev) =>
        prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]
      );
    };
    const onUpdated = (msg) => {
      setChannels((prev) =>
        prev.map((c) =>
          c.id === msg.channelId && c.lastMessage?.id === msg.id
            ? { ...c, lastMessage: { ...c.lastMessage, body: msg.body } }
            : c
        )
      );
    };
    const onDeleted = ({ id, channelId }) => {
      setChannels((prev) =>
        prev.map((c) =>
          c.id === channelId && c.lastMessage?.id === id
            ? { ...c, lastMessage: null }
            : c
        )
      );
    };
    const onRemoved = ({ channelId }) => {
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      setActiveChannelId((curr) => (curr === channelId ? null : curr));
    };
    const onMembers = ({ channelId, members }) => {
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, members } : c))
      );
    };

    const onPresenceState = ({ userIds }) => setOnlineUserIds(new Set(userIds));
    const onPresenceUpdate = ({ userId, online }) =>
      setOnlineUserIds((prev) => {
        const next = new Set(prev);
        if (online) next.add(userId);
        else next.delete(userId);
        return next;
      });

    const onTyping = ({ channelId, userId }) => {
      const key = `${channelId}:${userId}`;
      setTypingByChannel((prev) => {
        const list = prev[channelId] || [];
        return list.includes(userId)
          ? prev
          : { ...prev, [channelId]: [...list, userId] };
      });
      clearTimeout(typingTimers.current[key]);
      typingTimers.current[key] = setTimeout(() => {
        setTypingByChannel((prev) => ({
          ...prev,
          [channelId]: (prev[channelId] || []).filter((id) => id !== userId),
        }));
        delete typingTimers.current[key];
      }, 4000);
    };

    // Another of this user's devices/tabs read a channel -> clear its unread here.
    const onRead = ({ channelId }) =>
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, unread: false } : c))
      );

    // A convos was flagged unread from another device/tab -> reflect the badge.
    const onUnread = ({ channelId }) =>
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, unread: true } : c))
      );

    s.on("message:new", onNew);
    s.on("channel:created", onCreated);
    s.on("channel:removed", onRemoved);
    s.on("channel:members", onMembers);
    s.on("message:updated", onUpdated);
    s.on("message:deleted", onDeleted);
    s.on("presence:state", onPresenceState);
    s.on("presence:update", onPresenceUpdate);
    s.on("typing:update", onTyping);
    s.on("channel:read", onRead);
    s.on("channel:unread", onUnread);
    return () => {
      s.off("message:new", onNew);
      s.off("channel:created", onCreated);
      s.off("channel:removed", onRemoved);
      s.off("channel:members", onMembers);
      s.off("message:updated", onUpdated);
      s.off("message:deleted", onDeleted);
      s.off("presence:state", onPresenceState);
      s.off("presence:update", onPresenceUpdate);
      s.off("typing:update", onTyping);
      s.off("channel:read", onRead);
      s.off("channel:unread", onUnread);
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    ensureReady();
    // PWA: register the service worker + (re)subscribe push if permission was
    // already granted. On first install / iOS Add-to-Home-Screen, the user
    // still has to grant permission (we expose a "Activer les notifications"
    // toggle in the user menu — see Sidebar.jsx).
    ensurePwaReady();
    // Re-validate the push subscription whenever the app returns to the
    // foreground: a subscription pruned/expired while backgrounded would
    // otherwise silently stop delivering pushes until a full reload.
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        resubscribeIfNeeded();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [user]);

  // Deep-link from a notification click → focus the matching channel. The PWA
  // module emits `pwa:deeplink` for both messages (open tab) and Cache-Storage
  // recovery (cold app launch). The URL format set by the server is
  // `/?channel=<channelId>` (see webpush.js); we parse it client-side without
  // a real router.
  useEffect(() => {
    if (!user) return;
    function onDeepLink(e) {
      try {
        const url = new URL(e.detail?.url || "/", window.location.origin);
        const target = url.searchParams.get("channel");
        if (target) {
          setActiveChannelId(target);
          // Make sure the unread badge clears like a normal selection.
          setChannels((prev) =>
            prev.map((c) => (c.id === target ? { ...c, unread: false } : c))
          );
        }
      } catch {
        // Ignore malformed URLs.
      }
    }
    window.addEventListener("pwa:deeplink", onDeepLink);
    return () => window.removeEventListener("pwa:deeplink", onDeepLink);
  }, [user]);

  // PWA cold-start hardening (#95): on launch we reopen the last viewed
  // conversation straight away (see saveLastChannelId above), so the app boots
  // directly into the conversation view. The "close conversation" sentinel below
  // would then pop back to the initial launch entry, which on Android PWAs
  // unloads the document into a frozen black screen instead of revealing the
  // channel list. Seed one "list" guard entry up front so the system back button
  // always lands on a real in-app view (the list) rather than escaping the app.
  //
  // Fire once, on mobile, while we're still on the LAUNCH entry — detected by the
  // absence of one of our own pane markers in history.state (rather than the
  // brittle `history.length <= 1`: a freshly launched standalone PWA does start at
  // length 1, but an installed shortcut, a start_url redirect, or a test harness
  // can launch at length 2+, which silently disabled the guard).
  useEffect(() => {
    if (
      user &&
      !historyGuardRef.current &&
      !window.history.state?.chatPane &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      window.history.pushState({ chatPane: "list" }, "");
      historyGuardRef.current = true;
    }
  }, [user]);

  // PWA / mobile: the phone's system "back" button closes the open conversation
  // (shows the conversation list) instead of leaving the app. Sidebar and
  // conversation are mutually exclusive only in the single-pane mobile layout, so
  // this is a no-op on desktop/tablet (md+). Mechanism: opening a conversation
  // pushes one History sentinel; back pops it and we deselect the channel.
  useEffect(() => {
    const onPop = () => {
      backSentinelRef.current = false;
      if (window.matchMedia("(max-width: 767px)").matches) {
        setActiveChannelId((curr) => (curr ? null : curr));
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (
      activeChannelId &&
      !backSentinelRef.current &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      window.history.pushState({ chatPane: "conversation" }, "");
      backSentinelRef.current = true;
    }
  }, [activeChannelId]);

  // Tell the server whether the user can actually SEE the app: "activity" while
  // it's in the foreground (no push needed — they'll see the in-app toast),
  // "away" the instant it's hidden (PWA backgrounded, tab/window minimised, or —
  // on desktop — the Tauri window hidden to the tray, which document visibility
  // misses; isAppHidden() covers all three). The server then pushes to the
  // user's other devices instead of waiting out the idle window. Re-reported on
  // every (re)connect so a background reconnect isn't seen "active".
  useEffect(() => {
    if (!socket) return;
    const report = () => {
      socket.emit(isAppHidden() ? "away" : "activity");
    };
    report();
    socket.on("connect", report);
    const onVisibility = () => report();
    const onFocus = () => socket.emit("activity");
    // Desktop (Tauri): the native window was hidden to / restored from the tray.
    // document.visibilitychange doesn't fire for that, so desktop.js emits this.
    const onDesktopPresence = () => report();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("desktop:presence", onDesktopPresence);
    const iv = setInterval(() => {
      if (!isAppHidden()) socket.emit("activity");
    }, 60_000);
    return () => {
      socket.off("connect", report);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("desktop:presence", onDesktopPresence);
      clearInterval(iv);
    };
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    const onNotif = (data) => {
      if (data.channelId === activeChannelId && isWindowFocused()) return;
      setChannels((prev) => {
        const channel = prev.find((c) => c.id === data.channelId);
        const label = channel?.isDirect
          ? data.message.author?.displayName
          : `#${channel?.name || ""}`;
        const title = label || "Nouveau message";
        const body = data.message.body || "(pièce jointe)";
        setToast({ title, body });
        setTimeout(() => setToast(null), 4500);
        if (!isWindowFocused()) {
          notify(title, body);
          setTrayBadge(true); // desktop: red dot on the tray icon (no-op on web)
        }
        return prev;
      });
    };
    socket.on("notification", onNotif);
    return () => socket.off("notification", onNotif);
  }, [socket, activeChannelId]);

  // Desktop: clear the tray unread dot when the window regains focus.
  useEffect(() => {
    const onFocus = () => setTrayBadge(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const onLoggedIn = useCallback((u) => {
    setUser(u);
  }, []);

  const onLogout = useCallback(() => {
    // Best-effort: unsubscribe push BEFORE clearing the token so the API call
    // still authenticates. Don't block logout if it fails (network down etc.).
    unsubscribePush().catch(() => {});
    setToken(null);
    closeSocket();
    setUser(null);
    setChannels([]);
    setActiveChannelId(null);
  }, []);

  const onSelectChannel = useCallback((c) => {
    setActiveChannelId(c.id);
    setChannels((prev) =>
      prev.map((ch) => (ch.id === c.id ? { ...ch, unread: false } : ch))
    );
  }, []);

  const onMarkUnread = useCallback(
    (channelId) => {
      socket?.emit("channel:unread", { channelId });
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, unread: true } : c))
      );
      // Si le salon marqué non lu est celui ouvert, on le referme : sinon
      // ChannelView le repasserait aussitôt en "lu" (focus / message:new).
      setActiveChannelId((curr) => (curr === channelId ? null : curr));
    },
    [socket]
  );

  // Marquer lu sans ouvrir la conversation (action inverse dans le menu long-press).
  const onMarkRead = useCallback(
    (channelId) => {
      socket?.emit("channel:read", { channelId });
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, unread: false } : c))
      );
    },
    [socket]
  );

  const onNewChannelCreated = useCallback((channel) => {
    setChannels((prev) =>
      prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]
    );
    setActiveChannelId(channel.id);
    setShowNewChannel(false);
  }, []);

  const onDmOpened = useCallback((channel) => {
    setChannels((prev) =>
      prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]
    );
    setActiveChannelId(channel.id);
    setShowNewDm(false);
  }, []);

  const onChannelJoined = useCallback((channel) => {
    setChannels((prev) =>
      prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]
    );
    setActiveChannelId(channel.id);
  }, []);

  const onMembersAdded = useCallback((channel) => {
    setChannels((prev) => prev.map((c) => (c.id === channel.id ? channel : c)));
    setShowAddMembers(false);
  }, []);

  const onLeftChannel = useCallback((channelId) => {
    setChannels((prev) => prev.filter((c) => c.id !== channelId));
    setActiveChannelId((curr) => (curr === channelId ? null : curr));
    setShowMembers(false);
  }, []);

  const onMembersChanged = useCallback((channelId, members) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, members } : c))
    );
  }, []);

  const onNotifyLevelChange = useCallback((channelId, notifyLevel) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, notifyLevel } : c))
    );
  }, []);

  const toggleDnd = useCallback(() => {
    setShowDnd(true);
  }, []);

  const applyDnd = useCallback(async (minutes) => {
    const res = await api.setDnd(minutes);
    setUser(res.user);
    setShowDnd(false);
  }, []);

  const applySchedule = useCallback(async ({ enabled, start, end }) => {
    const res = await api.setDndSchedule(enabled, start, end);
    setUser(res.user);
  }, []);

  if (!bootstrapped) {
    return (
      <div className="h-screen grid place-items-center bg-aubergine-900 text-aubergine-400">
        Chargement…
      </div>
    );
  }

  if (!user) return <Login onLoggedIn={onLoggedIn} />;

  const activeChannel = channels.find((c) => c.id === activeChannelId) || null;
  const showUpdate =
    updateInfo?.updateAvailable && updateInfo.latest !== dismissedVersion;

  return (
    <div className="h-screen w-screen flex flex-col bg-aubergine-900">
      {showUpdate && (
        <UpdateBanner
          info={updateInfo}
          onDismiss={() => setDismissedVersion(updateInfo.latest)}
          onDesktopInstall={async () => {
            const update = desktopUpdateRef.current;
            if (!update) return;
            try {
              await installDesktopUpdate(update);
            } catch (e) {
              alert("Échec de la mise à jour : " + (e?.message || e));
            }
          }}
        />
      )}
      {/* Mobile web only (self-gates): invite to install the PWA, bottom of screen. */}
      <InstallPwaBanner />
      {/*
        Layout responsive : sur mobile (<md=768px) on n'affiche QU'UN écran à la fois,
        Sidebar (= liste des conversations) OU ChannelView (= la conversation ouverte).
        L'état "actif" est piloté par activeChannelId (déjà existant). Sur tablette+ (md+)
        les deux sont toujours visibles côte à côte comme avant. Aucun media-query JS :
        Tailwind hidden/md:flex fait tout le travail.
      */}
      <div className="flex-1 flex min-h-0">
        <div
          className={`${
            activeChannelId ? "hidden md:flex" : "flex"
          } flex-1 md:flex-none min-h-0`}
        >
          <Sidebar
            user={user}
            channels={channels}
            activeChannelId={activeChannelId}
            onSelectChannel={onSelectChannel}
            onMarkUnread={onMarkUnread}
            onMarkRead={onMarkRead}
            onNewChannel={(name) => {
              setNewChannelName(name || "");
              setShowNewChannel(true);
            }}
            onNewDm={() => setShowNewDm(true)}
            onChannelJoined={onChannelJoined}
            onDmOpened={onDmOpened}
            onToggleDnd={toggleDnd}
            onLogout={onLogout}
            onInvite={() => setShowInvite(true)}
            onProfile={() => setShowProfile(true)}
            onPreferences={() => setShowPreferences(true)}
            onReportBug={() => setShowBugReport(true)}
            onAdminPanel={() => setShowAdmin(true)}
            onlineUserIds={onlineUserIds}
            typingByChannel={typingByChannel}
          />
        </div>
        <div
          className={`${
            activeChannelId ? "flex" : "hidden md:flex"
          } flex-1 min-w-0 min-h-0`}
        >
          <ChannelView
            channel={activeChannel}
            currentUser={user}
            socket={socket}
            onlineUserIds={onlineUserIds}
            channels={channels}
            onSwitchChannel={onSelectChannel}
            onAddMembers={() => setShowAddMembers(true)}
            onShowMembers={() => setShowMembers(true)}
            onNotifyLevelChange={onNotifyLevelChange}
            onBackToList={() => {
              if (
                backSentinelRef.current &&
                window.matchMedia("(max-width: 767px)").matches
              ) {
                window.history.back(); // pop the sentinel → popstate deselects
              } else {
                setActiveChannelId(null);
              }
            }}
          />
        </div>
      </div>

      {showNewChannel && (
        <NewChannelModal
          currentUserId={user.id}
          initialName={newChannelName}
          onClose={() => {
            setShowNewChannel(false);
            setNewChannelName("");
          }}
          onCreated={onNewChannelCreated}
        />
      )}
      {showNewDm && (
        <NewDmModal
          currentUserId={user.id}
          onClose={() => setShowNewDm(false)}
          onOpened={onDmOpened}
        />
      )}
      {showAddMembers && activeChannel && !activeChannel.isDirect && (
        <AddMembersModal
          channel={activeChannel}
          currentUserId={user.id}
          onClose={() => setShowAddMembers(false)}
          onAdded={onMembersAdded}
        />
      )}
      {showMembers && activeChannel && !activeChannel.isDirect && (
        <MembersModal
          channel={activeChannel}
          currentUser={user}
          onClose={() => setShowMembers(false)}
          onLeft={onLeftChannel}
          onMembersChanged={onMembersChanged}
        />
      )}
      {showDnd && (
        <DndModal
          active={user.dndUntil && new Date(user.dndUntil) > new Date()}
          user={user}
          onClose={() => setShowDnd(false)}
          onPick={applyDnd}
          onSaveSchedule={applySchedule}
        />
      )}

      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
      {showProfile && (
        <ProfileModal
          user={user}
          onClose={() => setShowProfile(false)}
          onUpdated={(u) => setUser(u)}
        />
      )}
      {showPreferences && (
        <PreferencesModal onClose={() => setShowPreferences(false)} />
      )}
      {showBugReport && (
        <BugReportModal user={user} onClose={() => setShowBugReport(false)} />
      )}
      {showAdmin && (
        <AdminPanelModal
          currentUser={user}
          onClose={() => setShowAdmin(false)}
          onUserUpdated={(u) => setUser(u)}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-aubergine-800 text-white rounded-lg shadow-xl p-3 w-72 z-40">
          <div className="font-semibold text-sm">{toast.title}</div>
          <div className="text-sm opacity-90 truncate">{toast.body}</div>
        </div>
      )}
    </div>
  );
}
