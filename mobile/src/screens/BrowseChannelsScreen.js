import { useEffect, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from "react-native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import { colors } from "../theme";

export default function BrowseChannelsScreen({ navigation }) {
  const { upsertChannel } = useChat();
  const [channels, setChannels] = useState([]);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    navigation.setOptions({ title: "Parcourir les salons" });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    api.publicChannels(q).then((res) => !cancelled && setChannels(res.channels));
    return () => {
      cancelled = true;
    };
  }, [q]);

  async function join(c) {
    setBusyId(c.id);
    try {
      const res = await api.joinChannel(c.id);
      upsertChannel(res.channel);
      navigation.replace("Channel", { channelId: res.channel.id });
    } catch {
      setBusyId(null);
    }
  }

  return (
    <View style={styles.container}>
      <TextInput style={styles.search} placeholder="Rechercher un salon public…" value={q} onChangeText={setQ} autoCapitalize="none" />
      <ScrollView>
        {channels.map((c) => (
          <View key={c.id} style={styles.row}>
            <Text style={styles.hash}>#</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{c.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {c.members.length} membre{c.members.length > 1 ? "s" : ""}
                {c.description ? ` · ${c.description}` : ""}
              </Text>
            </View>
            <Pressable style={styles.joinBtn} disabled={busyId === c.id} onPress={() => join(c)}>
              <Text style={styles.joinText}>Rejoindre</Text>
            </Pressable>
          </View>
        ))}
        {channels.length === 0 && <Text style={styles.empty}>Aucun salon public à rejoindre.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  search: { margin: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, color: colors.text },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, gap: 10 },
  hash: { color: colors.textMuted, fontSize: 18 },
  name: { fontWeight: "600", color: colors.text },
  meta: { color: colors.textMuted, fontSize: 12 },
  joinBtn: { backgroundColor: colors.aubergine, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  joinText: { color: colors.white, fontWeight: "600", fontSize: 13 },
  empty: { textAlign: "center", color: colors.textMuted, padding: 24 },
});
