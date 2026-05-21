import { useEffect, useState, useCallback, useRef } from "react";
import { api, getToken, setToken } from "./api.js";
import { getSocket, closeSocket } from "./socket.js";
import { notify, isWindowFocused, ensureReady } from "./desktop.js";
import Login from "./components/Login.jsx";
import Sidebar from "./components/Sidebar.jsx";
import ChannelView from "./components/ChannelView.jsx";
import NewChannelModal from "./components/NewChannelModal.jsx";
import NewDmModal from "./components/NewDmModal.jsx";
import DndModal from "./components/DndModal.jsx";

export default function App() {
  const [user, setUser] = useState(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [channels, setChannels] = useState([]);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [socket, setSocket] = useState(null);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);
  const [showDnd, setShowDnd] = useState(false);
  const [toast, setToast] = useState(null);
  const [onlineUserIds, setOnlineUserIds] = useState(() => new Set());
  const [typingByChannel, setTypingByChannel] = useState({});
  const typingTimers = useRef({});

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
        prev.map((c) =>
          c.id === msg.channelId
            ? {
                ...c,
                lastMessage: {
                  id: msg.id,
                  body: msg.body,
                  createdAt: msg.createdAt,
                  authorId: msg.author?.id,
                },
              }
            : c
        )
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

    s.on("message:new", onNew);
    s.on("channel:created", onCreated);
    s.on("message:updated", onUpdated);
    s.on("message:deleted", onDeleted);
    s.on("presence:state", onPresenceState);
    s.on("presence:update", onPresenceUpdate);
    s.on("typing:update", onTyping);
    return () => {
      s.off("message:new", onNew);
      s.off("channel:created", onCreated);
      s.off("message:updated", onUpdated);
      s.off("message:deleted", onDeleted);
      s.off("presence:state", onPresenceState);
      s.off("presence:update", onPresenceUpdate);
      s.off("typing:update", onTyping);
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    ensureReady();
  }, [user]);

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
    setToken(null);
    closeSocket();
    setUser(null);
    setChannels([]);
    setActiveChannelId(null);
  }, []);

  const onSelectChannel = useCallback((c) => {
    setActiveChannelId(c.id);
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

  const toggleDnd = useCallback(() => {
    setShowDnd(true);
  }, []);

  const applyDnd = useCallback(async (minutes) => {
    const res = await api.setDnd(minutes);
    setUser(res.user);
    setShowDnd(false);
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

  return (
    <div className="h-screen w-screen flex bg-aubergine-900">
      <Sidebar
        user={user}
        channels={channels}
        activeChannelId={activeChannelId}
        onSelectChannel={onSelectChannel}
        onNewChannel={() => setShowNewChannel(true)}
        onNewDm={() => setShowNewDm(true)}
        onToggleDnd={toggleDnd}
        onLogout={onLogout}
        onlineUserIds={onlineUserIds}
        typingByChannel={typingByChannel}
      />
      <ChannelView
        channel={activeChannel}
        currentUser={user}
        socket={socket}
        onlineUserIds={onlineUserIds}
      />

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
      {showDnd && (
        <DndModal
          active={user.dndUntil && new Date(user.dndUntil) > new Date()}
          onClose={() => setShowDnd(false)}
          onPick={applyDnd}
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
