import { useEffect, useRef, useState, useCallback, useLayoutEffect } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  Modal,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  AppState,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import MessageItem from "../components/MessageItem";
import Composer from "../components/Composer";
import PresenceDot from "../components/PresenceDot";
import { colors } from "../theme";
import { dayLabel, typingLabel } from "../format";

export default function ChannelScreen({ route, navigation }) {
  const { channelId } = route.params;
  const { user, socket, channels, onlineUserIds, setActiveChannel, markRead } = useChat();
  const channel = channels.find((c) => c.id === channelId);

  const [messages, setMessages] = useState([]);
  const [typingUserIds, setTypingUserIds] = useState([]);
  const [scheduled, setScheduled] = useState([]);
  const [showScheduled, setShowScheduled] = useState(false);
  // Discord-style: tap "Répondre" sets the quoted target; the next send carries
  // `parentId` and clears it. No more push to a Thread screen.
  const [replyingTo, setReplyingTo] = useState(null);
  const listRef = useRef(null);
  const messageIndexRef = useRef({}); // id → index, for FlatList.scrollToIndex
  const typingTimers = useRef({});
  const lastTypingSent = useRef(0);

  // Tap a quote bubble → scroll to the original message in the timeline.
  // FlatList needs a numeric index, so we keep a fresh map alongside `messages`.
  useEffect(() => {
    const next = {};
    messages.forEach((m, i) => {
      next[m.id] = i;
    });
    messageIndexRef.current = next;
  }, [messages]);

  function jumpToMessage(id) {
    const idx = messageIndexRef.current[id];
    if (idx == null) return;
    try {
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
    } catch {
      /* index briefly stale during a re-render — ignore */
    }
  }

  // Mark active + read while focused.
  useFocusEffect(
    useCallback(() => {
      setActiveChannel(channelId);
      markRead(channelId);
      return () => setActiveChannel(null);
    }, [channelId, setActiveChannel, markRead])
  );

  // If the channel disappears (left/removed), go back.
  useEffect(() => {
    if (channels.length && !channel) navigation.goBack();
  }, [channel, channels.length, navigation]);

  const dmOther = channel?.isDirect
    ? channel.members.find((m) => m.id !== user?.id) || channel.members[0]
    : null;
  const isGroup = channel?.isDirect && channel.members.length > 2;
  const title = channel?.isDirect ? channel.displayName : `# ${channel?.name || ""}`;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View>
          <Text style={styles.hTitle} numberOfLines={1}>
            {title}
          </Text>
          {channel?.isDirect ? (
            isGroup ? (
              <Text style={styles.hSub}>Groupe · {channel.members.length} personnes</Text>
            ) : (
              <View style={styles.hSubRow}>
                <PresenceDot online={onlineUserIds?.has(dmOther?.id)} size={8} />
                <Text style={styles.hSub}>
                  {onlineUserIds?.has(dmOther?.id) ? "En ligne" : "Hors ligne"}
                </Text>
              </View>
            )
          ) : (
            <Pressable onPress={() => navigation.navigate("Members", { channelId })}>
              <Text style={styles.hSubLink}>
                {channel?.members.length} membre{channel?.members.length > 1 ? "s" : ""}
              </Text>
            </Pressable>
          )}
        </View>
      ),
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingRight: 4 }}>
          <Pressable onPress={() => setShowScheduled(true)}>
            <Text style={styles.hAction}>⏰ {scheduled.length}</Text>
          </Pressable>
          {channel && !channel.isDirect && (
            <Pressable onPress={() => navigation.navigate("AddMembers", { channelId })}>
              <Text style={styles.hAction}>+ Membres</Text>
            </Pressable>
          )}
        </View>
      ),
    });
  }, [navigation, title, channel, isGroup, dmOther, onlineUserIds, scheduled.length, channelId]);

  // Load messages + scheduled, join room.
  useEffect(() => {
    let cancelled = false;
    setTypingUserIds([]);
    api.messages(channelId).then((res) => !cancelled && setMessages(res.messages));
    api.scheduled(channelId).then((res) => !cancelled && setScheduled(res.scheduled));
    socket?.emit("channel:join", channelId);
    // Only mark read when the app is actually in the foreground (not merely
    // because this screen is mounted) — a backgrounded app must not clear unread
    // on the user's other devices.
    if (AppState.currentState === "active") socket?.emit("channel:read", { channelId });
    return () => {
      cancelled = true;
    };
  }, [channelId, socket]);

  // Returning the app to the foreground with this channel open marks it read
  // (covers messages received while it was backgrounded).
  useEffect(() => {
    if (!socket) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") socket.emit("channel:read", { channelId });
    });
    return () => sub.remove();
  }, [socket, channelId]);

  // Message-level realtime.
  useEffect(() => {
    if (!socket) return;
    function onNew(msg) {
      // Discord-style: replies arrive on `message:new` too (parent quote
      // carried inline in `msg.parent`), so a single handler covers both.
      if (msg.channelId !== channelId) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      if (AppState.currentState === "active") socket.emit("channel:read", { channelId });
    }
    function onUpdated(msg) {
      if (msg.channelId !== channelId) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    }
    function onDeleted({ id, channelId: cid }) {
      if (cid !== channelId) return;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setReplyingTo((curr) => (curr?.id === id ? null : curr));
    }
    function onReaction({ messageId, reactions }) {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
    }
    function onTyping({ channelId: cid, userId }) {
      if (cid !== channelId || userId === user?.id) return;
      setTypingUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
      clearTimeout(typingTimers.current[userId]);
      typingTimers.current[userId] = setTimeout(() => {
        setTypingUserIds((prev) => prev.filter((id) => id !== userId));
        delete typingTimers.current[userId];
      }, 4000);
    }
    socket.on("message:new", onNew);
    socket.on("message:updated", onUpdated);
    socket.on("message:deleted", onDeleted);
    socket.on("reaction:update", onReaction);
    socket.on("typing:update", onTyping);
    return () => {
      socket.off("message:new", onNew);
      socket.off("message:updated", onUpdated);
      socket.off("message:deleted", onDeleted);
      socket.off("reaction:update", onReaction);
      socket.off("typing:update", onTyping);
      Object.values(typingTimers.current).forEach(clearTimeout);
      typingTimers.current = {};
    };
  }, [socket, channelId, user?.id]);

  useEffect(() => {
    if (messages.length)
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [messages.length]);

  function send(payload) {
    if (!socket) return;
    const parentId = replyingTo?.id || null;
    socket.emit("message:send", { channelId, parentId, ...payload }, (resp) => {
      if (resp?.scheduled) setScheduled((prev) => [...prev, resp.scheduled]);
    });
    setReplyingTo(null);
  }

  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current < 2000) return;
    lastTypingSent.current = now;
    socket?.emit("typing", { channelId });
  }

  async function editMessage(id, body) {
    try {
      const res = await api.editMessage(id, body);
      setMessages((prev) => prev.map((m) => (m.id === id ? res.message : m)));
      return true;
    } catch {
      return false;
    }
  }
  async function deleteMessage(message) {
    try {
      await api.deleteMessage(message.id);
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    } catch {}
  }
  async function react(messageId, emoji) {
    try {
      await api.react(messageId, emoji);
    } catch {}
  }
  async function cancelScheduled(id) {
    await api.deleteScheduled(id);
    setScheduled((prev) => prev.filter((m) => m.id !== id));
  }

  let lastDay = null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingVertical: 8 }}
        renderItem={({ item, index }) => {
          const prev = messages[index - 1];
          const day = dayLabel(item.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          const grouped =
            prev &&
            !showDay &&
            prev.author?.id === item.author?.id &&
            new Date(item.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
          return (
            <View>
              {showDay && (
                <View style={styles.dayRow}>
                  <View style={styles.dayLine} />
                  <Text style={styles.dayText}>{day}</Text>
                  <View style={styles.dayLine} />
                </View>
              )}
              <MessageItem
                message={item}
                grouped={grouped}
                currentUser={user}
                onReact={react}
                onReply={(m) => setReplyingTo(m)}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onJumpToParent={jumpToMessage}
              />
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>Premier message dans cette conversation.</Text>
        }
      />

      {typingUserIds.length > 0 && (
        <Text style={styles.typing}>{typingLabel(typingUserIds, channel, user)}</Text>
      )}

      {replyingTo && (
        <View style={styles.replyBanner}>
          <Text style={styles.replyBannerLabel}>
            ↩ Réponse à {replyingTo.author?.displayName || "?"}
          </Text>
          <Text style={styles.replyBannerSnippet} numberOfLines={1}>
            {(replyingTo.body || "").trim() || "(pièce jointe)"}
          </Text>
          <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
            <Text style={styles.replyBannerClose}>✕</Text>
          </Pressable>
        </View>
      )}

      <Composer
        onSend={send}
        onTyping={notifyTyping}
        placeholder={channel?.isDirect ? `Message à ${title}` : `Message dans ${title}`}
      />

      <Modal visible={showScheduled} transparent animationType="slide" onRequestClose={() => setShowScheduled(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowScheduled(false)}>
          <Pressable style={styles.schedSheet} onPress={() => {}}>
            <Text style={styles.schedTitle}>Messages planifiés</Text>
            {scheduled.length === 0 ? (
              <Text style={styles.empty}>Aucun message planifié</Text>
            ) : (
              scheduled.map((m) => (
                <View key={m.id} style={styles.schedRow}>
                  <Text style={styles.schedWhen}>
                    {new Date(m.scheduledAt).toLocaleString()}
                  </Text>
                  <Text style={styles.schedBody} numberOfLines={1}>
                    {m.body}
                  </Text>
                  <Pressable onPress={() => cancelScheduled(m.id)}>
                    <Text style={styles.schedCancel}>Annuler</Text>
                  </Pressable>
                </View>
              ))
            )}
            <Pressable style={styles.closeBtn} onPress={() => setShowScheduled(false)}>
              <Text style={styles.closeBtnText}>Fermer</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  hTitle: { color: colors.white, fontWeight: "700", fontSize: 16, maxWidth: 220 },
  hSub: { color: colors.aubergineMuted, fontSize: 12 },
  hSubLink: { color: colors.aubergineMuted, fontSize: 12, textDecorationLine: "underline" },
  hSubRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  hAction: { color: colors.white, fontSize: 13, fontWeight: "600" },
  dayRow: { flexDirection: "row", alignItems: "center", marginVertical: 10, paddingHorizontal: 12 },
  dayLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dayText: { paddingHorizontal: 10, color: colors.textMuted, fontSize: 12 },
  empty: { textAlign: "center", color: colors.textMuted, padding: 24 },
  typing: { paddingHorizontal: 14, paddingVertical: 2, fontStyle: "italic", color: colors.textMuted, fontSize: 12 },
  replyBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.aubergineLight + "20",
    borderTopWidth: 1,
    borderTopColor: colors.aubergineLight + "60",
  },
  replyBannerLabel: { color: colors.aubergine, fontWeight: "700", fontSize: 12 },
  replyBannerSnippet: { flex: 1, color: colors.textMuted, fontSize: 12 },
  replyBannerClose: { color: colors.textMuted, fontSize: 16, paddingHorizontal: 4 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  schedSheet: { backgroundColor: colors.white, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  schedTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 10 },
  schedRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  schedWhen: { fontSize: 12, color: colors.text, fontWeight: "600" },
  schedBody: { flex: 1, color: colors.textMuted, fontSize: 13 },
  schedCancel: { color: colors.red, fontWeight: "600", fontSize: 13 },
  closeBtn: { marginTop: 16, alignSelf: "center" },
  closeBtnText: { color: colors.aubergine, fontWeight: "600", fontSize: 15 },
});
