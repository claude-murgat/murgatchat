import { useState, useLayoutEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  StyleSheet,
} from "react-native";
import { useChat } from "../ChatContext";
import Avatar from "../components/Avatar";
import PresenceDot from "../components/PresenceDot";
import { colors } from "../theme";

function dndActive(user) {
  return user?.dndUntil && new Date(user.dndUntil) > new Date();
}

export default function ChannelListScreen({ navigation }) {
  const { user, channels, onlineUserIds, typingByChannel, markRead, logout } = useChat();
  const [menu, setMenu] = useState(false);

  const groups = channels.filter((c) => !c.isDirect);
  const dms = channels.filter((c) => c.isDirect);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => setMenu(true)} style={{ paddingHorizontal: 12 }}>
          <Text style={{ color: colors.white, fontSize: 22 }}>⋯</Text>
        </Pressable>
      ),
    });
  }, [navigation]);

  function open(c) {
    markRead(c.id);
    navigation.navigate("Channel", { channelId: c.id });
  }

  return (
    <View style={styles.container}>
      <View style={styles.workspace}>
        <View style={{ flex: 1 }}>
          <Text style={styles.wsName}>Chat Workspace</Text>
          <View style={styles.wsUserRow}>
            <PresenceDot online size={8} />
            <Text style={styles.wsUser}>{user?.displayName}</Text>
          </View>
          {dndActive(user) && (
            <Text style={styles.dndLine}>
              Ne pas déranger · jusqu'à{" "}
              {new Date(user.dndUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
          )}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingVertical: 8 }}>
        <SectionHeader
          title="Salons"
          onAdd={() => navigation.navigate("NewChannel")}
          onBrowse={() => navigation.navigate("Browse")}
        />
        {groups.length === 0 && <Text style={styles.emptyLine}>Aucun salon</Text>}
        {groups.map((c) => (
          <Pressable key={c.id} style={styles.row} onPress={() => open(c)}>
            <Text style={styles.prefix}>{c.isPrivate ? "🔒" : "#"}</Text>
            <Text style={[styles.rowName, c.unread && styles.unreadName]} numberOfLines={1}>
              {c.name || "salon"}
            </Text>
            {c.unread && <View style={styles.unreadDot} />}
          </Pressable>
        ))}

        <SectionHeader title="Messages directs" onAdd={() => navigation.navigate("NewDm")} />
        {dms.length === 0 && <Text style={styles.emptyLine}>Aucun DM</Text>}
        {dms.map((c) => {
          const other = c.members.find((m) => m.id !== user?.id) || c.members[0];
          const isGroup = c.members.length > 2;
          const isTyping = (typingByChannel?.[c.id]?.length || 0) > 0;
          return (
            <Pressable key={c.id} style={styles.row} onPress={() => open(c)}>
              {isTyping ? (
                <View style={styles.typingBadge}>
                  <Text style={styles.typingDots}>…</Text>
                </View>
              ) : isGroup ? (
                <View style={styles.groupBadge}>
                  <Text style={styles.groupCount}>{c.members.length}</Text>
                </View>
              ) : (
                <Avatar user={other} size={32} />
              )}
              {!isGroup && (
                <View style={{ position: "absolute", left: 34, top: 30 }}>
                  <PresenceDot online={onlineUserIds?.has(other?.id)} size={10} />
                </View>
              )}
              <Text style={[styles.rowName, { marginLeft: 10 }, c.unread && styles.unreadName]} numberOfLines={1}>
                {c.displayName || "DM"}
              </Text>
              {c.unread && <View style={styles.unreadDot} />}
            </Pressable>
          );
        })}
      </ScrollView>

      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenu(false)}>
          <View style={styles.menu}>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                navigation.navigate("Dnd");
              }}
            >
              <Text style={styles.menuText}>
                {dndActive(user) ? "Ne pas déranger (actif)" : "Ne pas déranger"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                logout();
              }}
            >
              <Text style={[styles.menuText, { color: colors.red }]}>Se déconnecter</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function SectionHeader({ title, onAdd, onBrowse }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={{ flexDirection: "row", gap: 14 }}>
        {onBrowse && (
          <Pressable onPress={onBrowse}>
            <Text style={styles.sectionAction}>🔍</Text>
          </Pressable>
        )}
        <Pressable onPress={onAdd}>
          <Text style={styles.sectionAction}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  workspace: { backgroundColor: colors.aubergine, paddingHorizontal: 16, paddingVertical: 12 },
  wsName: { color: colors.white, fontWeight: "700", fontSize: 16 },
  wsUserRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  wsUser: { color: colors.aubergineMuted },
  dndLine: { color: "#FFC857", marginTop: 2, fontSize: 12 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  sectionTitle: { textTransform: "uppercase", color: colors.textMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  sectionAction: { fontSize: 16, color: colors.textMuted },
  emptyLine: { paddingHorizontal: 16, paddingVertical: 6, color: colors.textMuted, fontSize: 13 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  prefix: { width: 24, color: colors.textMuted, fontSize: 15 },
  rowName: { flex: 1, color: colors.text, fontSize: 15 },
  unreadName: { fontWeight: "700" },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.aubergine },
  groupBadge: { width: 32, height: 32, borderRadius: 6, backgroundColor: colors.aubergineLight, alignItems: "center", justifyContent: "center" },
  groupCount: { color: colors.white, fontWeight: "700", fontSize: 13 },
  typingBadge: { width: 32, height: 32, borderRadius: 6, backgroundColor: colors.aubergineLight, alignItems: "center", justifyContent: "center" },
  typingDots: { color: colors.white, fontWeight: "700", fontSize: 16 },
  menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.2)" },
  menu: { position: "absolute", top: 6, right: 8, backgroundColor: colors.white, borderRadius: 10, paddingVertical: 4, minWidth: 200, elevation: 6, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  menuItem: { paddingVertical: 12, paddingHorizontal: 16 },
  menuText: { fontSize: 15, color: colors.text },
});
