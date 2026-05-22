import { useEffect, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import Avatar from "../components/Avatar";
import { Check } from "./AddMembersScreen";
import { colors } from "../theme";

export default function NewDmScreen({ navigation }) {
  const { user, upsertChannel } = useChat();
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: "Nouveau message" });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    api.listUsers(q).then((res) => {
      if (!cancelled) setUsers(res.users.filter((u) => u.id !== user?.id));
    });
    return () => {
      cancelled = true;
    };
  }, [q, user?.id]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function start() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await api.openDm(Array.from(selected));
      upsertChannel(res.channel);
      navigation.replace("Channel", { channelId: res.channel.id });
    } catch {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <TextInput style={styles.search} placeholder="Rechercher une ou plusieurs personnes…" value={q} onChangeText={setQ} autoCapitalize="none" />
      <Text style={styles.hint}>Sélectionnez plusieurs personnes pour créer un groupe.</Text>
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
        {users.length === 0 && <Text style={styles.empty}>Aucun utilisateur</Text>}
      </ScrollView>
      <Pressable style={[styles.cta, selected.size === 0 && styles.ctaOff]} disabled={busy || selected.size === 0} onPress={start}>
        <Text style={styles.ctaText}>
          {selected.size > 1 ? `Créer le groupe (${selected.size})` : "Démarrer"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  search: { marginHorizontal: 12, marginTop: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, color: colors.text },
  hint: { color: colors.textMuted, fontSize: 12, paddingHorizontal: 14, paddingTop: 4, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 9 },
  name: { fontWeight: "600", color: colors.text },
  username: { color: colors.textMuted, fontSize: 12 },
  empty: { textAlign: "center", color: colors.textMuted, padding: 24 },
  cta: { backgroundColor: colors.aubergine, margin: 12, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  ctaOff: { opacity: 0.5 },
  ctaText: { color: colors.white, fontWeight: "700", fontSize: 15 },
});
