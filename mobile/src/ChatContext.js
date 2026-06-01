import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { api, getToken, setToken, loadApiBaseUrl } from "./api";
import { getSocket, closeSocket } from "./socket";
import { registerForPush } from "./push";

const ChatContext = createContext(null);

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

export function ChatProvider({ children }) {
  const [user, setUser] = useState(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  // "network" when the stored session couldn't be resumed because the server is
  // unreachable (vs. a real auth rejection). Drives the retry banner on login.
  const [bootstrapError, setBootstrapError] = useState(null);
  const [channels, setChannels] = useState([]);
  const [socket, setSocket] = useState(null);
  const [onlineUserIds, setOnlineUserIds] = useState(() => new Set());
  const [typingByChannel, setTypingByChannel] = useState({});
  const [toast, setToast] = useState(null);

  const activeChannelIdRef = useRef(null);
  const typingTimers = useRef({});
  const toastTimer = useRef(null);

  const setActiveChannel = useCallback((id) => {
    activeChannelIdRef.current = id;
  }, []);

  // Register for push notifications once authenticated (no-op until push creds set).
  useEffect(() => {
    if (user) registerForPush();
  }, [user]);

  // Bootstrap: load the configured server address, then resume any stored session.
  // Two invariants the old version violated and that froze the cold-start splash
  // (#42): (1) `bootstrapped` must ALWAYS flip to true, even if something before
  // api.me() throws; (2) the stored token must only be dropped on a real auth
  // rejection (401/403) — an unreachable server / timeout keeps the session and
  // surfaces a retryable "Serveur injoignable" banner instead of logging the user
  // out for a transient network blip.
  const runBootstrap = useCallback(async () => {
    try {
      await loadApiBaseUrl();
      const token = await getToken();
      if (!token) {
        setBootstrapError(null);
        return; // no stored session → straight to login
      }
      try {
        const res = await api.me();
        setUser(res.user);
        setBootstrapError(null);
      } catch (e) {
        if (e?.status === 401 || e?.status === 403) {
          await setToken(null); // session genuinely invalid → clear it
          setBootstrapError(null);
        } else {
          setBootstrapError("network"); // unreachable/timeout/5xx → keep token, offer retry
        }
      }
    } catch {
      // A failure before api.me() (storage read, etc.) must not trap the splash.
      setBootstrapError("network");
    } finally {
      setBootstrapped(true);
    }
  }, []);

  useEffect(() => {
    runBootstrap();
  }, [runBootstrap]);

  // Socket + channel list once authenticated.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let s;
    (async () => {
      const token = await getToken();
      s = getSocket(token);
      if (cancelled) return;
      setSocket(s);
      api.listChannels().then((res) => {
        if (!cancelled) setChannels(res.channels);
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
      const onCreated = (channel) =>
        setChannels((prev) =>
          prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]
        );
      const onUpdated = (msg) =>
        setChannels((prev) =>
          prev.map((c) =>
            c.id === msg.channelId && c.lastMessage?.id === msg.id
              ? { ...c, lastMessage: { ...c.lastMessage, body: msg.body } }
              : c
          )
        );
      const onDeleted = ({ id, channelId }) =>
        setChannels((prev) =>
          prev.map((c) =>
            c.id === channelId && c.lastMessage?.id === id
              ? { ...c, lastMessage: null }
              : c
          )
        );
      const onRemoved = ({ channelId }) => {
        setChannels((prev) => prev.filter((c) => c.id !== channelId));
        if (activeChannelIdRef.current === channelId)
          activeChannelIdRef.current = null;
      };
      const onMembers = ({ channelId, members }) =>
        setChannels((prev) =>
          prev.map((c) => (c.id === channelId ? { ...c, members } : c))
        );
      const onPresenceState = ({ userIds }) => setOnlineUserIds(new Set(userIds));
      const onPresenceUpdate = ({ userId, online }) =>
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          if (online) next.add(userId);
          else next.delete(userId);
          return next;
        });
      const onTyping = ({ channelId, userId }) => {
        if (userId === user.id) return;
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
      const onNotif = (data) => {
        if (data.channelId === activeChannelIdRef.current) return;
        setChannels((prev) => {
          const channel = prev.find((c) => c.id === data.channelId);
          const label = channel?.isDirect
            ? data.message.author?.displayName
            : `#${channel?.name || ""}`;
          const title = label || "Nouveau message";
          const body = data.message.body || "(pièce jointe)";
          clearTimeout(toastTimer.current);
          setToast({ title, body });
          toastTimer.current = setTimeout(() => setToast(null), 4000);
          return prev;
        });
      };

      // Read on another of this user's devices -> clear unread here too.
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
      s.on("notification", onNotif);
      s.on("channel:read", onRead);

      s._detach = () => {
        s.off("message:new", onNew);
        s.off("channel:created", onCreated);
        s.off("channel:removed", onRemoved);
        s.off("channel:members", onMembers);
        s.off("message:updated", onUpdated);
        s.off("message:deleted", onDeleted);
        s.off("presence:state", onPresenceState);
        s.off("presence:update", onPresenceUpdate);
        s.off("typing:update", onTyping);
        s.off("notification", onNotif);
        s.off("channel:read", onRead);
      };
    })();

    return () => {
      cancelled = true;
      if (s?._detach) s._detach();
    };
  }, [user]);

  const markRead = useCallback(
    (channelId) => {
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, unread: false } : c))
      );
      socket?.emit("channel:read", { channelId });
    },
    [socket]
  );

  const upsertChannel = useCallback((channel) => {
    setChannels((prev) =>
      prev.some((c) => c.id === channel.id)
        ? prev.map((c) => (c.id === channel.id ? channel : c))
        : [...prev, channel]
    );
  }, []);

  const patchChannel = useCallback((channelId, patch) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, ...patch } : c))
    );
  }, []);

  const dropChannel = useCallback((channelId) => {
    setChannels((prev) => prev.filter((c) => c.id !== channelId));
    if (activeChannelIdRef.current === channelId)
      activeChannelIdRef.current = null;
  }, []);

  const login = useCallback((u) => setUser(u), []);

  const logout = useCallback(async () => {
    await setToken(null);
    closeSocket();
    setUser(null);
    setSocket(null);
    setChannels([]);
    setOnlineUserIds(new Set());
    setTypingByChannel({});
  }, []);

  const value = {
    user,
    setUser,
    bootstrapped,
    bootstrapError,
    retryConnection: runBootstrap,
    channels,
    socket,
    onlineUserIds,
    typingByChannel,
    toast,
    setActiveChannel,
    markRead,
    upsertChannel,
    patchChannel,
    dropChannel,
    login,
    logout,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
