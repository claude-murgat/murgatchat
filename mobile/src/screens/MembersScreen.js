import { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { api } from "../api";
import { useChat } from "../ChatContext";
import Avatar from "../components/Avatar";
import { colors } from "../theme";

export default function MembersScreen({ route, navigation }) {
  const { channelId } = route.params;
  const { user, channels, patchChannel, dropChannel } = useChat();
  const channel = channels.find((c) => c.id === channelId);
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const members = channel?.members || [];
  const canManage = channel && !channel.isDefault;

  useEffect(() => {
    navigation.setOptions({
      title: channel?.name ? `Membres · #${channel.name}` : "Membres",
    });
  }, [navigation, channel?.name]);

  useEffect(() => {
    if (channels.length && !channel) navigation.goBack();
  }, [channel, channels.length, navigation]);

  async function remove(u) {
    setBusy(true);
    try {
      await api.removeMember(channelId, u.id);
      patchChannel(channelId, { members: members.filter((m) => m.id !== u.id) });
    } catch {}
    setBusy(false);
  }

  async function leave() {
    setBusy(true);
    try {
      await api.leaveChannel(channelId);
      dropChannel(channelId);
      navigation.popToTop();
    } catch {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Text style={styles.count}>
          {members.length} membre{members.length > 1 ? "s" : ""}
        </Text>
        {canManage && (
          <Pressable style={styles.addBtn} onPress={() => navigation.navigate("AddMembers", { channelId })}>
            <Text style={styles.addBtnText}>＋ Ajouter</Text>
          </Pressable>
        )}
      </View>

      <ScrollView>
        {members.map((u) => (
          <View key={u.id} style={styles.row}>
            <Avatar user={u} size={36} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.name}>
                {u.displayName}
                {u.id === user?.id ? " (vous)" : ""}
              </Text>
              <Text style={styles.username}>@{u.username}</Text>
            </View>
            {canManage && u.id !== user?.id && (
              <Pressable disabled={busy} onPress={() => remove(u)}>
                <Text style={styles.remove}>Retirer</Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>

      <View style={styles.footer}>
        {canManage ? (
          confirmLeave ? (
            <View style={styles.confirmRow}>
              <Text style={styles.confirmText}>Quitter le salon ?</Text>
              <Pressable style={styles.leaveBtn} disabled={busy} onPress={leave}>
                <Text style={styles.leaveBtnText}>Quitter</Text>
              </Pressable>
              <Pressable onPress={() => setConfirmLeave(false)}>
                <Text style={styles.cancel}>Annuler</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setConfirmLeave(true)}>
              <Text style={styles.leaveLink}>Quitter le salon</Text>
            </Pressable>
          )
        ) : (
          <Text style={styles.defaultNote}>Salon par défaut</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  count: { fontWeight: "700", color: colors.text, fontSize: 15 },
  addBtn: { backgroundColor: colors.aubergine, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  addBtnText: { color: colors.white, fontWeight: "600", fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  name: { fontWeight: "600", color: colors.text },
  username: { color: colors.textMuted, fontSize: 12 },
  remove: { color: colors.red, fontWeight: "600", fontSize: 13 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: colors.border },
  leaveLink: { color: colors.red, fontWeight: "600" },
  confirmRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  confirmText: { color: colors.text, flex: 1 },
  leaveBtn: { backgroundColor: colors.red, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  leaveBtnText: { color: colors.white, fontWeight: "700" },
  cancel: { color: colors.textMuted },
  defaultNote: { color: colors.textMuted, fontSize: 12 },
});
