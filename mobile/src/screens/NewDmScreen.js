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
    // We keep the caller in the list: picking only yourself opens (or reopens)
    // the "Mes notes" self-DM. Sorted to the top so it's easy to spot.
    api.listUsers(q).then((res) => {
      if (cancelled) return;
      const sorted = [...res.users].sort((a, b) => {
        if (a.id === user?.id) return -1;
        if (b.id === user?.id) return 1;
        return 0;
      });
      setUsers(sorted);
    });
    return () => {
      cancelled = true;
    };
  }, [q, user?.id]);

  // A self-DM is a one-member channel — picking yourself is mutually exclusive
  // with picking anyone else. The opposite rows are visually disabled so the
  // constraint is obvious (and a tap on them is a no-op).
  const selfPicked = selected.has(user?.id);
  const othersPicked = selected.size > 0 && !selfPicked;

  function toggle(id) {
    const isSelf = id === user?.id;
    if (isSelf) {
      setSelected((prev) => (prev.has(id) ? new Set() : new Set([id])));
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(user?.id); // defensive — disabled state above prevents reaching this
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }
  }

  async function start() {
    // Allow opening the self-DM with zero selections (sent as `userIds: []`).
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
        {users.map((u) => {
          const isMe = u.id === user?.id;
          const disabled = isMe ? othersPicked : selfPicked;
          return (
            <Pressable
              key={u.id}
              style={[styles.row, disabled && styles.rowDisabled]}
              disabled={disabled}
              onPress={() => toggle(u.id)}
            >
              <Check on={selected.has(u.id)} />
              <Avatar user={u} size={32} />
              <View style={{ marginLeft: 10 }}>
                <Text style={styles.name}>
                  {isMe ? "📝 Mes notes" : u.displayName}
                </Text>
                <Text style={styles.username}>
                  {isMe ? "(notes pour vous-même)" : `@${u.username}`}
                </Text>
              </View>
            </Pressable>
          );
        })}
        {users.length === 0 && <Text style={styles.empty}>Aucun utilisateur</Text>}
      </ScrollView>
      <Pressable style={styles.cta} disabled={busy} onPress={start}>
        <Text style={styles.ctaText}>
          {selected.size === 0
            ? "Ouvrir mes notes"
            : selected.size === 1 && selected.has(user?.id)
            ? "Ouvrir mes notes"
            : selected.size > 1
            ? `Créer le groupe (${selected.size})`
            : "Démarrer"}
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
  rowDisabled: { opacity: 0.4 },
  name: { fontWeight: "600", color: colors.text },
  username: { color: colors.textMuted, fontSize: 12 },
  empty: { textAlign: "center", color: colors.textMuted, padding: 24 },
  cta: { backgroundColor: colors.aubergine, margin: 12, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  ctaOff: { opacity: 0.5 },
  ctaText: { color: colors.white, fontWeight: "700", fontSize: 15 },
});
