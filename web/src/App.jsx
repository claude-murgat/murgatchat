import { useEffect, useState, useCallback, useRef } from "react";
import { api, getToken, setToken } from "./api.js";
import { getSocket, closeSocket } from "./socket.js";
import { notify, isWindowFocused, ensureReady } from "./desktop.js";
import { ensurePwaReady, isPwaInstalled, unsubscribePush } from "./pwa.js";
import Login from "./components/Login.jsx";
import Sidebar from "./components/Sidebar.jsx";
import ChannelView from "./components/ChannelView.jsx";
import NewChannelModal from "./components/NewChannelModal.jsx";
import NewDmModal from "./components/NewDmModal.jsx";
import BrowseChannelsModal from "./components/BrowseChannelsModal.jsx";
import AddMembersModal from "./components/AddMembersModal.jsx";
import MembersModal from "./components/MembersModal.jsx";
import DndModal from "./components/DndModal.jsx";
import InviteModal from "./components/InviteModal.jsx";
import ProfileModal from "./components/ProfileModal.jsx";
import SearchModal from "./components/SearchModal.jsx";
import AdminPanelModal from "./components/AdminPanelModal.jsx";
import PreferencesModal from "./components/PreferencesModal.jsx";
import BugReportModal from "./components/BugReportModal.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import { checkForUpdate } from "./version.js";
import { setLogContext, logEvent } from "./logbuffer.js";

export default function App() {
  const [user, setUser] = useState(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [channels, setChannels] = useState([]);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [socket, setSocket] = useState(null);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);
  const [showDnd, setShowDnd] = useState(false);
  const [showBrowseChannels, setShowBrowseChannels] = useState(false);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
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
  }, [activeChannelId]);

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

  // Version check: on mount, on window focus, and every 15 min. If the server
  // advertises a newer version, surface the banner (web → refresh, desktop →
  // download). Only runs once authenticated (the bulk of usage time).
  useEffect(() => {
    if (!user) return;
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

  useEffect(() => {
    if (!user) return;
    const token = getToken();
    const s = getSocket(token);
    setSocket(s);
    api.listChannels().then((res) => {
      setChannels(res.channels);
      setActiveChannelId((curr) => curr || res.channels[0]?.id || null);
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

  // Cmd/Ctrl+K opens the search modal — global, only when logged in.
  useEffect(() => {
    if (!user) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
      if (e.key === "Escape") setShowSearch(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user]);

  // Tell the server whether the user can actually SEE the app: "activity" while
  // the page is visible (no push needed — they'll see the in-app toast), "away"
  // the instant it's hidden (PWA backgrounded, window/tab minimised). The server
  // then pushes immediately instead of waiting out a 10-min idle window. Also
  // re-reported on every (re)connect so a background reconnect isn't seen "active".
  useEffect(() => {
    if (!socket) return;
    const report = () => {
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      socket.emit(hidden ? "away" : "activity");
    };
    report();
    socket.on("connect", report);
    const onVisibility = () => report();
    const onFocus = () => socket.emit("activity");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    const iv = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        socket.emit("activity");
      }
    }, 60_000);
    return () => {
      socket.off("connect", report);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
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
        }
        return prev;
      });
    };
    socket.on("notification", onNotif);
    return () => socket.off("notification", onNotif);
  }, [socket, activeChannelId]);

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
    setShowBrowseChannels(false);
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
        />
      )}
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
            onNewChannel={() => setShowNewChannel(true)}
            onNewDm={() => setShowNewDm(true)}
            onBrowseChannels={() => setShowBrowseChannels(true)}
            onToggleDnd={toggleDnd}
            onLogout={onLogout}
            onInvite={() => setShowInvite(true)}
            onProfile={() => setShowProfile(true)}
            onPreferences={() => setShowPreferences(true)}
            onReportBug={() => setShowBugReport(true)}
            onSearch={() => setShowSearch(true)}
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
            onAddMembers={() => setShowAddMembers(true)}
            onShowMembers={() => setShowMembers(true)}
            onBackToList={() => setActiveChannelId(null)}
          />
        </div>
      </div>

      {showNewChannel && (
        <NewChannelModal
          currentUserId={user.id}
          onClose={() => setShowNewChannel(false)}
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
      {showBrowseChannels && (
        <BrowseChannelsModal
          onClose={() => setShowBrowseChannels(false)}
          onJoined={onChannelJoined}
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
      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onJump={(r) => {
            setActiveChannelId(r.channelId);
            setShowSearch(false);
            // Clear the unread badge — picking a result acts like selecting the channel.
            setChannels((prev) =>
              prev.map((c) => (c.id === r.channelId ? { ...c, unread: false } : c))
            );
          }}
        />
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
