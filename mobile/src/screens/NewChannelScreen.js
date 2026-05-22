import { useEffect, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import Avatar from "../components/Avatar";
import { Check } from "./AddMembersScreen";
import { colors } from "../theme";

export default function NewChannelScreen({ navigation }) {
  const { user, upsertChannel } = useChat();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: "Créer une conversation" });
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

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.createChannel({
        name: name.trim(),
        description: description.trim() || undefined,
        isPrivate,
        memberIds: Array.from(selected),
      });
      upsertChannel(res.channel);
      navigation.replace("Channel", { channelId: res.channel.id });
    } catch {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
        <TextInput style={styles.input} placeholder="Nom du salon (ex. marketing)" value={name} onChangeText={setName} />
        <TextInput style={styles.input} placeholder="Description (optionnel)" value={description} onChangeText={setDescription} />
        <Pressable style={styles.checkRow} onPress={() => setIsPrivate((v) => !v)}>
          <Check on={isPrivate} />
          <Text style={styles.checkLabel}>Salon privé</Text>
        </Pressable>

        <Text style={styles.subhead}>Ajouter des membres</Text>
        <TextInput style={styles.input} placeholder="Rechercher…" value={q} onChangeText={setQ} autoCapitalize="none" />
        {users.map((u) => (
          <Pressable key={u.id} style={styles.row} onPress={() => toggle(u.id)}>
            <Check on={selected.has(u.id)} />
            <Avatar user={u} size={28} />
            <View style={{ marginLeft: 10 }}>
              <Text style={styles.name}>{u.displayName}</Text>
              <Text style={styles.username}>@{u.username}</Text>
            </View>
          </Pressable>
        ))}
        {users.length === 0 && <Text style={styles.empty}>Aucun utilisateur</Text>}
      </ScrollView>
      <Pressable style={[styles.cta, !name.trim() && styles.ctaOff]} disabled={busy || !name.trim()} onPress={submit}>
        <Text style={styles.ctaText}>Créer</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, color: colors.text, marginBottom: 10 },
  checkRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4, marginBottom: 6 },
  checkLabel: { color: colors.text, fontSize: 15 },
  subhead: { fontWeight: "700", color: colors.text, marginTop: 8, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  name: { fontWeight: "600", color: colors.text },
  username: { color: colors.textMuted, fontSize: 12 },
  empty: { color: colors.textMuted, padding: 12 },
  cta: { backgroundColor: colors.aubergine, margin: 12, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  ctaOff: { opacity: 0.5 },
  ctaText: { color: colors.white, fontWeight: "700", fontSize: 15 },
});
