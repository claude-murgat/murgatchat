import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  Image,
  Modal,
  Linking,
  StyleSheet,
} from "react-native";
import Avatar from "./Avatar";
import EmojiPicker from "./EmojiPicker";
import { colors } from "../theme";
import { formatTime, reactionLabel, fmtBytes } from "../format";
import { attachmentUrl } from "../api";

function Attachments({ attachments }) {
  if (!attachments?.length) return null;
  return (
    <View style={styles.attachments}>
      {attachments.map((a) => {
        const url = attachmentUrl(a.id);
        const isImg = a.mimeType?.startsWith("image/");
        if (isImg) {
          return (
            <Pressable key={a.id} onPress={() => Linking.openURL(url)}>
              <Image source={{ uri: url }} style={styles.image} resizeMode="cover" />
            </Pressable>
          );
        }
        return (
          <Pressable key={a.id} style={styles.fileChip} onPress={() => Linking.openURL(url)}>
            <Text style={styles.fileIcon}>📄</Text>
            <Text style={styles.fileName} numberOfLines={1}>
              {a.filename}
            </Text>
            <Text style={styles.fileSize}>{fmtBytes(a.size)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function MessageItem({
  message,
  grouped,
  currentUser,
  onReact,
  onReply,
  onEdit,
  onDelete,
}) {
  const isOwn = message.author?.id === currentUser?.id;
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body || "");
  const [picker, setPicker] = useState(false);
  const [whoReacted, setWhoReacted] = useState(null);

  function openMenu() {
    setConfirmDel(false);
    setMenu(true);
  }

  async function saveEdit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === message.body) {
      setEditing(false);
      return;
    }
    const ok = await onEdit(message.id, trimmed);
    if (ok) setEditing(false);
  }

  const Body = (
    <View style={{ flex: 1, minWidth: 0 }}>
      {!grouped && (
        <View style={styles.headerRow}>
          <Text style={styles.author}>{message.author?.displayName}</Text>
          <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
        </View>
      )}
      {editing ? (
        <View>
          <TextInput
            style={styles.editInput}
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
          />
          <View style={styles.editBtns}>
            <Pressable style={styles.saveBtn} onPress={saveEdit}>
              <Text style={styles.saveBtnText}>Enregistrer</Text>
            </Pressable>
            <Pressable onPress={() => setEditing(false)}>
              <Text style={styles.cancelText}>Annuler</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        !!message.body && (
          <Text style={styles.body}>
            {message.body}
            {message.editedAt && <Text style={styles.edited}> (modifié)</Text>}
          </Text>
        )
      )}
      <Attachments attachments={message.attachments} />

      {onReply && message.replyCount > 0 && (
        <Pressable onPress={() => onReply(message)}>
          <Text style={styles.replyLink}>
            💬 {message.replyCount} réponse{message.replyCount > 1 ? "s" : ""}
          </Text>
        </Pressable>
      )}

      {message.reactions?.length > 0 && (
        <View style={styles.chips}>
          {message.reactions.map((r) => {
            const mine = r.users?.some((u) => u.id === currentUser?.id);
            return (
              <Pressable
                key={r.emoji}
                onPress={() => onReact?.(message.id, r.emoji)}
                onLongPress={() => setWhoReacted(reactionLabel(r.users))}
                style={[styles.chip, mine && styles.chipMine]}
              >
                <Text style={styles.chipEmoji}>{r.emoji}</Text>
                <Text style={[styles.chipCount, mine && styles.chipCountMine]}>{r.count}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {whoReacted && (
        <Pressable onPress={() => setWhoReacted(null)}>
          <Text style={styles.whoReacted}>{whoReacted}</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <Pressable
      onLongPress={openMenu}
      delayLongPress={250}
      style={[styles.row, grouped && styles.rowGrouped]}
    >
      {grouped ? (
        <View style={styles.gutter} />
      ) : (
        <View style={{ marginRight: 10 }}>
          <Avatar user={message.author} size={36} />
        </View>
      )}
      {Body}

      {!editing && (
        <Pressable style={styles.kebab} onPress={openMenu} hitSlop={8}>
          <Text style={styles.kebabText}>⋯</Text>
        </Pressable>
      )}

      {/* Action menu */}
      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenu(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            {!confirmDel ? (
              <>
                <MenuItem
                  label="😀  Réagir"
                  onPress={() => {
                    setMenu(false);
                    setPicker(true);
                  }}
                />
                {onReply && (
                  <MenuItem
                    label="💬  Répondre dans un fil"
                    onPress={() => {
                      setMenu(false);
                      onReply(message);
                    }}
                  />
                )}
                {isOwn && (
                  <MenuItem
                    label="✏️  Modifier"
                    onPress={() => {
                      setMenu(false);
                      setDraft(message.body || "");
                      setEditing(true);
                    }}
                  />
                )}
                {isOwn && (
                  <MenuItem label="🗑️  Supprimer" danger onPress={() => setConfirmDel(true)} />
                )}
              </>
            ) : (
              <View style={{ padding: 8 }}>
                <Text style={styles.confirmText}>Supprimer ce message ?</Text>
                <View style={styles.confirmBtns}>
                  <Pressable
                    style={styles.delBtn}
                    onPress={() => {
                      setMenu(false);
                      onDelete(message);
                    }}
                  >
                    <Text style={styles.delBtnText}>Supprimer</Text>
                  </Pressable>
                  <Pressable onPress={() => setConfirmDel(false)}>
                    <Text style={styles.cancelText}>Annuler</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <EmojiPicker
        visible={picker}
        onSelect={(emoji) => onReact?.(message.id, emoji)}
        onClose={() => setPicker(false)}
      />
    </Pressable>
  );
}

function MenuItem({ label, onPress, danger }) {
  return (
    <Pressable style={styles.menuItem} onPress={onPress}>
      <Text style={[styles.menuItemText, danger && { color: colors.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", paddingHorizontal: 12, paddingVertical: 6 },
  rowGrouped: { paddingVertical: 1 },
  kebab: { position: "absolute", right: 8, top: 4, paddingHorizontal: 6, paddingVertical: 2 },
  kebabText: { color: colors.textMuted, fontSize: 18, fontWeight: "700" },
  gutter: { width: 46 },
  headerRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { fontWeight: "700", color: colors.text },
  time: { color: colors.textMuted, fontSize: 11 },
  body: { color: colors.text, marginTop: 1, lineHeight: 20 },
  edited: { color: colors.textMuted, fontSize: 11 },
  attachments: { marginTop: 4, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  image: { width: 180, height: 140, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F1F1F1",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    maxWidth: 240,
  },
  fileIcon: { fontSize: 16 },
  fileName: { flex: 1, color: colors.text, fontSize: 13 },
  fileSize: { color: colors.textMuted, fontSize: 11 },
  replyLink: { color: colors.aubergine, fontWeight: "600", fontSize: 13, marginTop: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FAFAFA",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipMine: { borderColor: colors.aubergine, backgroundColor: "#3F0E4015" },
  chipEmoji: { fontSize: 13 },
  chipCount: { fontSize: 12, color: colors.textMuted },
  chipCountMine: { color: colors.aubergine, fontWeight: "700" },
  whoReacted: { fontSize: 11, color: colors.textMuted, marginTop: 3, fontStyle: "italic" },
  editInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.text,
    marginTop: 2,
  },
  editBtns: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 },
  saveBtn: { backgroundColor: colors.green, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  saveBtnText: { color: colors.white, fontWeight: "600", fontSize: 13 },
  cancelText: { color: colors.textMuted, fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 8, paddingBottom: 24 },
  menuItem: { paddingVertical: 14, paddingHorizontal: 12 },
  menuItemText: { fontSize: 16, color: colors.text },
  confirmText: { fontSize: 16, color: colors.text, paddingVertical: 8, paddingHorizontal: 4 },
  confirmBtns: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 4, paddingTop: 8 },
  delBtn: { backgroundColor: colors.red, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  delBtnText: { color: colors.white, fontWeight: "700" },
});
