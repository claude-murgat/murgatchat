import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { colors } from "../theme";

const EMOJIS = [
  "👍", "👎", "❤️", "🎉", "😂", "😮", "😢", "😡",
  "🙏", "🔥", "👏", "✅", "❌", "👀", "💯", "🚀",
  "😍", "🤔", "😅", "😎", "🙌", "💪", "🥳", "😴",
  "🤝", "👋", "💡", "⭐", "✨", "🤣", "😭", "😉",
  "🤩", "😋", "🤗", "🫶", "💔", "☕", "🍕", "🎁",
];

export default function EmojiPicker({ visible, onSelect, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation?.()}>
          <Text style={styles.title}>Choisir un emoji</Text>
          <ScrollView contentContainerStyle={styles.grid}>
            {EMOJIS.map((e) => (
              <Pressable
                key={e}
                style={styles.cell}
                onPress={() => {
                  onSelect(e);
                  onClose();
                }}
              >
                <Text style={styles.emoji}>{e}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 16,
    maxWidth: 360,
    width: "100%",
  },
  title: { fontWeight: "700", color: colors.text, marginBottom: 10, fontSize: 16 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center" },
  cell: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  emoji: { fontSize: 26 },
});
