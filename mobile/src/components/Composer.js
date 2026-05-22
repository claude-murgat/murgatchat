import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import EmojiPicker from "./EmojiPicker";
import { colors } from "../theme";

export default function Composer({ onSend, onTyping, placeholder, allowSchedule = true }) {
  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [minutes, setMinutes] = useState("");

  function send(schedule = false) {
    const body = text.trim();
    if (!body) return;
    const payload = { body, attachmentIds: [] };
    if (schedule) {
      const m = parseInt(minutes, 10);
      if (!m || m <= 0) return;
      payload.scheduledAt = new Date(Date.now() + m * 60_000).toISOString();
    }
    onSend(payload);
    setText("");
    setMinutes("");
    setShowSchedule(false);
  }

  return (
    <View style={styles.wrap}>
      {showSchedule && (
        <View style={styles.scheduleRow}>
          <Text style={styles.scheduleLabel}>Dans</Text>
          <TextInput
            style={styles.minutesInput}
            placeholder="minutes"
            keyboardType="number-pad"
            value={minutes}
            onChangeText={setMinutes}
          />
          <Text style={styles.scheduleLabel}>min</Text>
          <Pressable style={styles.scheduleBtn} onPress={() => send(true)}>
            <Text style={styles.scheduleBtnText}>Planifier</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.row}>
        <Pressable style={styles.iconBtn} onPress={() => setShowEmoji(true)}>
          <Text style={styles.icon}>😀</Text>
        </Pressable>
        {allowSchedule && (
          <Pressable style={styles.iconBtn} onPress={() => setShowSchedule((v) => !v)}>
            <Text style={styles.icon}>⏰</Text>
          </Pressable>
        )}
        <TextInput
          style={styles.input}
          placeholder={placeholder || "Écrire un message…"}
          value={text}
          onChangeText={(t) => {
            setText(t);
            onTyping?.();
          }}
          multiline
        />
        <Pressable
          style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
          onPress={() => send(false)}
          disabled={!text.trim()}
        >
          <Text style={styles.sendText}>Envoyer</Text>
        </Pressable>
      </View>
      <EmojiPicker
        visible={showEmoji}
        onSelect={(e) => setText((t) => t + e)}
        onClose={() => setShowEmoji(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.white, padding: 8 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  iconBtn: { paddingHorizontal: 4, paddingVertical: 8 },
  icon: { fontSize: 20 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxHeight: 120,
    color: colors.text,
  },
  sendBtn: { backgroundColor: colors.green, borderRadius: 18, paddingHorizontal: 14, justifyContent: "center", height: 38 },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: colors.white, fontWeight: "600" },
  scheduleRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 8 },
  scheduleLabel: { color: colors.textMuted },
  minutesInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    width: 90,
    color: colors.text,
  },
  scheduleBtn: { marginLeft: "auto", backgroundColor: colors.blue, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  scheduleBtnText: { color: colors.white, fontWeight: "600" },
});
