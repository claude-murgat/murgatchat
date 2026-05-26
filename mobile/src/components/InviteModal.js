import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
  Platform,
} from "react-native";
import { api } from "../api";
import { colors } from "../theme";

// Admin-only "Inviter un utilisateur" UI. Mirrors web/src/components/InviteModal.jsx:
// create an invitation by email, show the email-sent status + link/code so the
// admin can share it manually, and list existing invitations with their status.
export default function InviteModal({ visible, onClose }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { link, emailSent, token }
  const [invitations, setInvitations] = useState([]);

  async function refresh() {
    try {
      const r = await api.listInvitations();
      setInvitations(r.invitations);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (visible) refresh();
  }, [visible]);

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.createInvitation(email.trim());
      setResult({ link: res.link, emailSent: res.emailSent, token: res.token });
      setEmail("");
      refresh();
    } catch (err) {
      setError(err.message || "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>Inviter un utilisateur</Text>
          <Text style={styles.subtitle}>
            Un e-mail d'invitation est envoyé ; vous pouvez aussi partager le lien/code.
          </Text>

          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.rowInput]}
              placeholder="email@exemple.fr"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
            <Pressable
              style={[styles.inviteBtn, (busy || !email.trim()) && styles.btnDisabled]}
              disabled={busy || !email.trim()}
              onPress={submit}
            >
              <Text style={styles.inviteBtnText}>{busy ? "…" : "Inviter"}</Text>
            </Pressable>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}
          {result && (
            <View style={styles.resultBox}>
              <Text style={{ color: result.emailSent ? "#16A34A" : "#B45309" }}>
                {result.emailSent
                  ? "E-mail envoyé ✓"
                  : "E-mail non envoyé (SMTP non configuré) — partagez le lien :"}
              </Text>
              {result.link && <Text style={styles.link}>{result.link}</Text>}
              <Text style={styles.codeLine}>
                Code : <Text style={styles.code}>{result.token}</Text>
              </Text>
            </View>
          )}

          <Text style={styles.listLabel}>Invitations</Text>
          <ScrollView style={styles.list}>
            {invitations.length === 0 && (
              <Text style={styles.emptyLine}>Aucune invitation</Text>
            )}
            {invitations.map((i) => (
              <View key={i.id} style={styles.listRow}>
                <Text style={styles.listEmail} numberOfLines={1}>
                  {i.email}
                </Text>
                <Text
                  style={[
                    styles.status,
                    {
                      color: i.acceptedAt
                        ? "#16A34A"
                        : i.pending
                        ? "#B45309"
                        : colors.textMuted,
                    },
                  ]}
                >
                  {i.acceptedAt ? "Inscrit" : i.pending ? "En attente" : "Expirée"}
                </Text>
              </View>
            ))}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>Fermer</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 20,
    maxHeight: "90%",
  },
  title: { fontSize: 20, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 4, marginBottom: 14 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    color: colors.text,
  },
  rowInput: { flex: 1 },
  inviteBtn: {
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  inviteBtnText: { color: colors.white, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
  error: { color: colors.red, fontSize: 13, marginTop: 8 },
  resultBox: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
    gap: 4,
  },
  link: { color: colors.aubergine },
  codeLine: { color: colors.textMuted },
  code: { fontFamily: Platform.OS === "ios" ? "Courier" : "monospace", color: colors.text },
  listLabel: {
    textTransform: "uppercase",
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 6,
  },
  list: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    maxHeight: 180,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
  listEmail: { flex: 1, color: colors.text, fontSize: 14 },
  status: { fontSize: 12, fontWeight: "600" },
  emptyLine: { paddingHorizontal: 12, paddingVertical: 10, color: colors.textMuted, fontSize: 13 },
  footer: { flexDirection: "row", justifyContent: "flex-end", marginTop: 16 },
  closeBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  closeBtnText: { color: colors.text, fontWeight: "600" },
});
