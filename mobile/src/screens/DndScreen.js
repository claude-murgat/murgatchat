import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import { Check } from "./AddMembersScreen";
import { colors } from "../theme";

function minutesUntilTomorrow(hour) {
  const now = new Date();
  const target = new Date();
  target.setDate(now.getDate() + 1);
  target.setHours(hour, 0, 0, 0);
  return Math.max(1, Math.round((target.getTime() - now.getTime()) / 60_000));
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function DndScreen({ navigation }) {
  const { user, setUser } = useChat();
  const active = user?.dndUntil && new Date(user.dndUntil) > new Date();

  const [enabled, setEnabled] = useState(!!user?.dndScheduleEnabled);
  const [start, setStart] = useState(user?.dndStart || "22:00");
  const [end, setEnd] = useState(user?.dndEnd || "08:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    navigation.setOptions({ title: "Ne pas déranger" });
  }, [navigation]);

  const presets = [
    { label: "30 minutes", minutes: 30 },
    { label: "1 heure", minutes: 60 },
    { label: "2 heures", minutes: 120 },
    { label: "Jusqu'à demain matin", minutes: minutesUntilTomorrow(8) },
    { label: "Toute la semaine", minutes: 60 * 24 * 7 },
  ];

  async function pick(minutes) {
    const res = await api.setDnd(minutes);
    setUser(res.user);
    navigation.goBack();
  }

  async function saveSchedule() {
    if (enabled && (!TIME_RE.test(start) || !TIME_RE.test(end))) {
      setError("Heures invalides (format HH:MM).");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const res = await api.setDndSchedule(enabled, start, end);
      setUser(res.user);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.section}>Couper les notifications pendant…</Text>
      {presets.map((p) => (
        <Pressable key={p.label} style={styles.preset} onPress={() => pick(p.minutes)}>
          <Text style={styles.presetText}>{p.label}</Text>
        </Pressable>
      ))}
      {active && (
        <Pressable style={styles.preset} onPress={() => pick(0)}>
          <Text style={[styles.presetText, { color: colors.red }]}>Désactiver maintenant</Text>
        </Pressable>
      )}

      <View style={styles.divider} />

      <Pressable style={styles.checkRow} onPress={() => setEnabled((v) => !v)}>
        <Check on={enabled} />
        <Text style={styles.checkLabel}>Planning quotidien (heures calmes)</Text>
      </Pressable>
      <View style={[styles.timeRow, !enabled && { opacity: 0.5 }]}>
        <Text style={styles.timeLabel}>De</Text>
        <TextInput style={styles.timeInput} value={start} onChangeText={setStart} editable={enabled} placeholder="22:00" />
        <Text style={styles.timeLabel}>à</Text>
        <TextInput style={styles.timeInput} value={end} onChangeText={setEnd} editable={enabled} placeholder="08:00" />
        <Pressable style={styles.saveBtn} disabled={saving} onPress={saveSchedule}>
          <Text style={styles.saveBtnText}>Enregistrer</Text>
        </Pressable>
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.note}>Coupe les notifications chaque jour sur cette plage (heure du serveur).</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  section: { color: colors.textMuted, marginBottom: 8 },
  preset: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  presetText: { fontSize: 16, color: colors.text },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
  checkRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
  checkLabel: { color: colors.text, fontSize: 15, fontWeight: "500" },
  timeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  timeLabel: { color: colors.text },
  timeInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, width: 72, color: colors.text, textAlign: "center" },
  saveBtn: { marginLeft: "auto", backgroundColor: colors.aubergine, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  saveBtnText: { color: colors.white, fontWeight: "600" },
  error: { color: colors.red, marginTop: 8, fontSize: 13 },
  note: { color: colors.textMuted, fontSize: 11, marginTop: 12 },
});
