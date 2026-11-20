import { memo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import Avatar from "./Avatar";
import PresenceDot from "./PresenceDot";
import { colors } from "../theme";
import { shortWhen, typingLabel } from "../format";
import { isExpert, isSelfDm, previewText } from "../conversations";

// Une conversation de l'accueil : icône (avatar et présence pour une conversation à
// deux, nombre de personnes pour un groupe, # ou 🔒 pour un salon), nom, extrait du
// dernier message (ou « … écrit… ») et son heure, pastille si non lue.
function ConversationRow({ channel: c, user, online, typingIds, onPress }) {
  const self = isSelfDm(c, user);
  const isGroup = c.isDirect && c.members.length > 2;
  const other = c.isDirect ? c.members.find((m) => m.id !== user?.id) || c.members[0] : null;
  const name = c.isDirect ? c.displayName || "DM" : c.name || "salon";
  const typing = typingIds?.length ? typingLabel(typingIds, c, user) : "";
  const preview = typing || previewText(c, user) || "Aucun message pour l'instant";
  const when = c.lastMessage?.createdAt ? shortWhen(c.lastMessage.createdAt) : "";

  let icon;
  if (self) {
    icon = (
      <View style={[styles.badge, styles.badgeGroup]}>
        <Text style={styles.badgeEmoji}>📝</Text>
      </View>
    );
  } else if (isGroup) {
    icon = (
      <View style={[styles.badge, styles.badgeGroup]}>
        <Text style={styles.badgeCount}>{c.members.length}</Text>
      </View>
    );
  } else if (c.isDirect) {
    icon = (
      <View>
        <Avatar user={other} size={40} />
        <View style={styles.presence}>
          <PresenceDot online={online} size={10} />
        </View>
      </View>
    );
  } else {
    icon = (
      <View style={[styles.badge, styles.badgeSalon]}>
        <Text style={styles.badgeSalonText}>{isExpert(c) ? "✨" : c.isPrivate ? "🔒" : "#"}</Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => onPress(c)}
      android_ripple={{ color: colors.aubergineTint }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${name}${c.unread ? ", non lu" : ""}`}
    >
      {icon}
      <View style={styles.body}>
        <View style={styles.line}>
          <Text style={[styles.name, c.unread && styles.bold]} numberOfLines={1}>
            {name}
          </Text>
          {!!when && <Text style={[styles.when, c.unread && styles.whenUnread]}>{when}</Text>}
        </View>
        <View style={styles.line}>
          <Text
            style={[styles.preview, c.unread && styles.previewUnread, !!typing && styles.typing]}
            numberOfLines={1}
          >
            {preview}
          </Text>
          {c.unread && <View style={styles.unreadDot} />}
        </View>
      </View>
    </Pressable>
  );
}

export default memo(ConversationRow);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: { backgroundColor: colors.aubergineTint },
  badge: { width: 40, height: 40, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  badgeGroup: { backgroundColor: colors.aubergineLight },
  badgeCount: { color: colors.white, fontWeight: "700", fontSize: 15 },
  badgeEmoji: { fontSize: 18 },
  badgeSalon: { backgroundColor: colors.aubergineTint },
  badgeSalonText: { color: colors.aubergine, fontWeight: "700", fontSize: 18 },
  presence: {
    position: "absolute",
    right: -3,
    bottom: -3,
    padding: 2,
    borderRadius: 8,
    backgroundColor: colors.white,
  },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, color: colors.text, fontSize: 15 },
  bold: { fontWeight: "700" },
  when: { color: colors.textMuted, fontSize: 12 },
  whenUnread: { color: colors.aubergine, fontWeight: "700" },
  preview: { flex: 1, color: colors.textMuted, fontSize: 13 },
  previewUnread: { color: colors.text },
  typing: { color: colors.aubergine, fontStyle: "italic" },
  unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.aubergine },
});
