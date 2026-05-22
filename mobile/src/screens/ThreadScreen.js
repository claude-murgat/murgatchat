import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import MessageItem from "../components/MessageItem";
import Composer from "../components/Composer";
import { colors } from "../theme";

export default function ThreadScreen({ route, navigation }) {
  const { channelId, parentId } = route.params;
  const { user, socket } = useChat();
  const [parent, setParent] = useState(null);
  const [replies, setReplies] = useState([]);
  const listRef = useRef(null);

  useEffect(() => {
    navigation.setOptions({ title: "Fil de discussion" });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    api.thread(parentId).then((res) => {
      if (cancelled) return;
      setParent(res.parent);
      setReplies(res.replies);
    });
    return () => {
      cancelled = true;
    };
  }, [parentId]);

  useEffect(() => {
    if (!socket) return;
    function onReply(msg) {
      if (msg.parentId !== parentId) return;
      setReplies((prev) => (prev.some((r) => r.id === msg.id) ? prev : [...prev, msg]));
    }
    function onUpdated(msg) {
      if (msg.id === parentId) return setParent(msg);
      if (msg.parentId !== parentId) return;
      setReplies((prev) => prev.map((r) => (r.id === msg.id ? msg : r)));
    }
    function onDeleted({ id, parentId: pid }) {
      if (id === parentId) return navigation.goBack();
      if (pid !== parentId) return;
      setReplies((prev) => prev.filter((r) => r.id !== id));
    }
    function onReaction({ messageId, reactions }) {
      setParent((p) => (p && p.id === messageId ? { ...p, reactions } : p));
      setReplies((prev) => prev.map((r) => (r.id === messageId ? { ...r, reactions } : r)));
    }
    socket.on("thread:reply", onReply);
    socket.on("message:updated", onUpdated);
    socket.on("message:deleted", onDeleted);
    socket.on("reaction:update", onReaction);
    return () => {
      socket.off("thread:reply", onReply);
      socket.off("message:updated", onUpdated);
      socket.off("message:deleted", onDeleted);
      socket.off("reaction:update", onReaction);
    };
  }, [socket, parentId, navigation]);

  async function editMessage(id, body) {
    try {
      const res = await api.editMessage(id, body);
      if (id === parentId) setParent(res.message);
      else setReplies((prev) => prev.map((m) => (m.id === id ? res.message : m)));
      return true;
    } catch {
      return false;
    }
  }
  async function deleteMessage(message) {
    try {
      await api.deleteMessage(message.id);
      if (message.id === parentId) navigation.goBack();
      else setReplies((prev) => prev.filter((m) => m.id !== message.id));
    } catch {}
  }
  async function react(messageId, emoji) {
    try {
      await api.react(messageId, emoji);
    } catch {}
  }
  function sendReply(payload) {
    socket?.emit("message:send", { channelId, parentId, ...payload });
  }

  const data = parent ? [parent, ...replies] : replies;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingVertical: 8 }}
        renderItem={({ item, index }) => (
          <View>
            <MessageItem
              message={item}
              grouped={false}
              currentUser={user}
              onReact={react}
              onEdit={editMessage}
              onDelete={deleteMessage}
            />
            {index === 0 && (
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>
                  {replies.length} réponse{replies.length > 1 ? "s" : ""}
                </Text>
                <View style={styles.dividerLine} />
              </View>
            )}
          </View>
        )}
      />
      <Composer onSend={sendReply} placeholder="Répondre…" allowSchedule={false} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 8, paddingHorizontal: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { paddingHorizontal: 10, color: colors.textMuted, fontSize: 12 },
});
