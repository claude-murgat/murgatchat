import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  RefreshControl,
} from "react-native";
import { api } from "../api";
import { colors } from "../theme";

function initialsFor(c, currentUserId) {
  if (c.isDirect) {
    const other = c.members.find((m) => m.id !== currentUserId) || c.members[0];
    return {
      name: other?.displayName || "DM",
      color: other?.avatarColor || colors.aubergine,
      prefix: "",
    };
  }
  return { name: c.name, color: colors.aubergine, prefix: "#" };
}

export default function ChannelListScreen({ navigation, route }) {
  const { user, onLogout } = route.params;
  const [channels, setChannels] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [dndUntil, setDndUntil] = useState(user.dndUntil);

  const load = useCallback(async () => {
    try {
      const res = await api.listChannels();
      setChannels(res.channels);
    } catch (e) {
      Alert.alert("Erreur", e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = navigation.addListener("focus", load);
    return unsub;
  }, [load, navigation]);

  async function toggleDnd() {
    const active = dndUntil && new Date(dndUntil) > new Date();
    const minutes = active ? 0 : 60;
    const res = await api.setDnd(minutes);
    setDndUntil(res.user.dndUntil);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.workspace}>Chat Workspace</Text>
          <Text style={styles.userLine}>Bonjour {user.displayName}</Text>
          {dndUntil && new Date(dndUntil) > new Date() && (
            <Text style={styles.dndLine}>
              Ne pas déranger jusqu'à {new Date(dndUntil).toLocaleTimeString()}
            </Text>
          )}
        </View>
        <TouchableOpacity onPress={toggleDnd} style={styles.dndBtn}>
          <Text style={styles.dndBtnText}>
            {dndUntil && new Date(dndUntil) > new Date() ? "DnD ON" : "DnD"}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={channels}
        keyExtractor={(c) => c.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        renderItem={({ item }) => {
          const info = initialsFor(item, user.id);
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() =>
                navigation.navigate("Channel", { channel: item, user })
              }
            >
              <View style={[styles.avatar, { backgroundColor: info.color }]}>
                <Text style={styles.avatarText}>
                  {info.prefix || info.name?.[0]?.toUpperCase() || "?"}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {info.prefix}
                  {info.name}
                </Text>
                <Text style={styles.rowPreview} numberOfLines={1}>
                  {item.lastMessage?.body || "—"}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Aucune conversation. Créez-en une depuis le web.
          </Text>
        }
      />

      <TouchableOpacity onPress={onLogout} style={styles.logout}>
        <Text style={styles.logoutText}>Se déconnecter</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    backgroundColor: colors.aubergine,
    padding: 16,
    paddingTop: 50,
    flexDirection: "row",
    alignItems: "center",
  },
  workspace: { color: colors.white, fontWeight: "700", fontSize: 18 },
  userLine: { color: colors.aubergineMuted, marginTop: 2 },
  dndLine: { color: "#FFC857", marginTop: 2, fontSize: 12 },
  dndBtn: {
    borderColor: colors.white,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  dndBtnText: { color: colors.white, fontSize: 12, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  avatarText: { color: colors.white, fontWeight: "700" },
  rowName: { fontWeight: "600", color: colors.text },
  rowPreview: { color: colors.textMuted, marginTop: 2, fontSize: 13 },
  empty: { textAlign: "center", color: colors.textMuted, padding: 24 },
  logout: {
    padding: 14,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  logoutText: { color: colors.red, fontWeight: "600" },
});
