import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { api, getToken } from "../api";
import { getSocket } from "../socket";
import { colors } from "../theme";

export default function ChannelScreen({ route, navigation }) {
  const { channel, user } = route.params;
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState("");
  const [scheduleMinutes, setScheduleMinutes] = useState("");
  const listRef = useRef(null);
  const socketRef = useRef(null);

  const headerTitle = channel.isDirect
    ? channel.displayName
    : `#${channel.name}`;

  useEffect(() => {
    navigation.setOptions({ title: headerTitle });
  }, [navigation, headerTitle]);

  useEffect(() => {
    let mounted = true;
    api.messages(channel.id).then((res) => {
      if (mounted) setMessages(res.messages);
    });

    let s;
    (async () => {
      const token = await getToken();
      s = getSocket(token);
      socketRef.current = s;
      s.emit("channel:join", channel.id);
      s.emit("channel:read", { channelId: channel.id });
      s.on("message:new", onNew);
    })();

    function onNew(msg) {
      if (msg.channelId !== channel.id) return;
      setMessages((prev) => [...prev, msg]);
    }

    return () => {
      mounted = false;
      if (s) s.off("message:new", onNew);
    };
  }, [channel.id]);

  useEffect(() => {
    if (messages.length) {
      requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: true })
      );
    }
  }, [messages.length]);

  function send(schedule = false) {
    const trimmed = body.trim();
    if (!trimmed || !socketRef.current) return;
    const payload = { channelId: channel.id, body: trimmed };
    if (schedule) {
      const minutes = parseInt(scheduleMinutes, 10);
      if (!minutes || minutes <= 0) {
        Alert.alert("Planification", "Indique un nombre de minutes > 0.");
        return;
      }
      payload.scheduledAt = new Date(Date.now() + minutes * 60_000).toISOString();
    }
    socketRef.current.emit("message:send", payload, (resp) => {
      if (resp?.error) Alert.alert("Erreur", resp.error);
      else if (resp?.scheduled)
        Alert.alert(
          "Planifié",
          `Envoi prévu à ${new Date(resp.scheduled.scheduledAt).toLocaleString()}`
        );
    });
    setBody("");
    setScheduleMinutes("");
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 64 : 0}
      style={styles.container}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item, index }) => {
          const prev = messages[index - 1];
          const grouped =
            prev &&
            prev.author?.id === item.author?.id &&
            new Date(item.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
          return <MessageItem message={item} grouped={grouped} />;
        }}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder={`Message dans ${headerTitle}`}
          value={body}
          onChangeText={setBody}
          multiline
        />
        <View style={styles.composerRow}>
          <TextInput
            style={[styles.input, styles.scheduleInput]}
            placeholder="minutes (planifié)"
            keyboardType="number-pad"
            value={scheduleMinutes}
            onChangeText={setScheduleMinutes}
          />
          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: colors.blue }]}
            onPress={() => send(true)}
          >
            <Text style={styles.sendText}>Planifier</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.sendBtn}
            onPress={() => send(false)}
            disabled={!body.trim()}
          >
            <Text style={styles.sendText}>Envoyer</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageItem({ message, grouped }) {
  if (grouped) {
    return (
      <View style={styles.msgGrouped}>
        <Text style={styles.msgBody}>{message.body}</Text>
      </View>
    );
  }
  return (
    <View style={styles.msgRow}>
      <View
        style={[
          styles.avatar,
          { backgroundColor: message.author?.avatarColor || colors.aubergine },
        ]}
      >
        <Text style={styles.avatarText}>
          {(message.author?.displayName || "?").slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.msgHeader}>
          <Text style={styles.msgAuthor}>{message.author?.displayName}</Text>
          <Text style={styles.msgTime}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        </View>
        <Text style={styles.msgBody}>{message.body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  composer: {
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.white,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
    color: colors.text,
  },
  composerRow: { flexDirection: "row", gap: 6 },
  scheduleInput: { flex: 1, marginBottom: 0 },
  sendBtn: {
    backgroundColor: colors.green,
    paddingHorizontal: 12,
    borderRadius: 8,
    justifyContent: "center",
  },
  sendText: { color: colors.white, fontWeight: "600" },
  msgRow: {
    flexDirection: "row",
    paddingVertical: 6,
  },
  msgGrouped: {
    paddingVertical: 2,
    paddingLeft: 48,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  avatarText: { color: colors.white, fontWeight: "700" },
  msgHeader: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  msgAuthor: { fontWeight: "700", color: colors.text },
  msgTime: { color: colors.textMuted, fontSize: 11 },
  msgBody: { color: colors.text, marginTop: 1 },
});
