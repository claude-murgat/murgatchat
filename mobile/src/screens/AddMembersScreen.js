import { useEffect, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import Avatar from "../components/Avatar";
import { colors } from "../theme";

export default function AddMembersScreen({ route, navigation }) {
  const { channelId } = route.params;
  const { user, channels, upsertChannel } = useChat();
  const channel = channels.find((c) => c.id === channelId);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const memberIds = new Set((channel?.members || []).map((m) => m.id));

  useEffect(() => {
    navigation.setOptions({ title: "Ajouter des membres" });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    api.listUsers(q).then((res) => {
      if (!cancelled)
        setUsers(res.users.filter((u) => u.id !== user?.id && !memberIds.has(u.id)));
    });
    return () => {
      cancelled = true;
    };
  }, [q, channel]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await api.addMembers(channelId, Array.from(selected));
      upsertChannel(res.channel);
      navigation.goBack();
    } catch {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <TextInput style={styles.search} placeholder="Rechercher quelqu'un…" value={q} onChangeText={setQ} autoCapitalize="none" />
      <ScrollView style={{ flex: 1 }}>
        {users.map((u) => (
          <Pressable key={u.id} style={styles.row} onPress={() => toggle(u.id)}>
            <Check on={selected.has(u.id)} />
            <Avatar user={u} size={32} />
            <View style={{ marginLeft: 10 }}>
              <Text style={styles.name}>{u.displayName}</Text>
              <Text style={styles.username}>@{u.username}</Text>
            </View>
          </Pressable>
        ))}
        {users.length === 0 && <Text style={styles.empty}>Aucun utilisateur à ajouter.</Text>}
      </ScrollView>
      <Pressable style={[styles.cta, selected.size === 0 && styles.ctaOff]} disabled={busy || selected.size === 0} onPress={submit}>
        <Text style={styles.ctaText}>Ajouter{selected.size > 0 ? ` (${selected.size})` : ""}</Text>
      </Pressable>
    </View>
  );
}

export function Check({ on }) {
  return (
    <View style={[styles.check, on && styles.checkOn]}>
      {on && <Text style={styles.checkMark}>✓</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  search: { margin: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, color: colors.text },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 9 },
  name: { fontWeight: "600", color: colors.text },
  username: { color: colors.textMuted, fontSize: 12 },
  empty: { textAlign: "center", color: colors.textMuted, padding: 24 },
  check: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: colors.border, marginRight: 10, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: colors.aubergine, borderColor: colors.aubergine },
  checkMark: { color: colors.white, fontSize: 13, fontWeight: "700" },
  cta: { backgroundColor: colors.aubergine, margin: 12, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  ctaOff: { opacity: 0.5 },
  ctaText: { color: colors.white, fontWeight: "700", fontSize: 15 },
});
