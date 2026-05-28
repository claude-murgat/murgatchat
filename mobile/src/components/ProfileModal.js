import { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
} from "react-native";
import { api } from "../api";
import { colors } from "../theme";

// Mirrors web/src/components/ProfileModal.jsx: update displayName and/or password.
// Password change requires the current password (defence-in-depth).
export default function ProfileModal({ visible, user, onClose, onUpdated }) {
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [busyName, setBusyName] = useState(false);
  const [busyPwd, setBusyPwd] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  // Re-sync the form to the current user every time the modal opens.
  useEffect(() => {
    if (visible && user) {
      setDisplayName(user.displayName || "");
      setCurrentPassword("");
      setNewPassword("");
      setNewPassword2("");
      setError(null);
      setInfo(null);
    }
  }, [visible, user]);

  async function saveName() {
    setError(null);
    setInfo(null);
    if (!displayName.trim()) {
      setError("Le nom affiché ne peut pas être vide.");
      return;
    }
    if (displayName.trim() === user.displayName) {
      setInfo("Aucun changement.");
      return;
    }
    setBusyName(true);
    try {
      const res = await api.updateProfile({ displayName: displayName.trim() });
      onUpdated?.(res.user);
      setInfo("Nom affiché mis à jour ✓");
    } catch (err) {
      setError(err.message || "Erreur");
    } finally {
      setBusyName(false);
    }
  }

  async function savePassword() {
    setError(null);
    setInfo(null);
    if (!currentPassword) {
      setError("Mot de passe actuel requis.");
      return;
    }
    if (newPassword.length < 6) {
      setError("Le nouveau mot de passe doit faire au moins 6 caractères.");
      return;
    }
    if (newPassword !== newPassword2) {
      setError("Les deux nouveaux mots de passe ne correspondent pas.");
      return;
    }
    setBusyPwd(true);
    try {
      await api.updateProfile({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setNewPassword2("");
      setInfo("Mot de passe mis à jour ✓");
    } catch (err) {
      if (err.message === "invalid_current_password") {
        setError("Mot de passe actuel incorrect.");
      } else {
        setError(err.message || "Erreur");
      }
    } finally {
      setBusyPwd(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>Mon profil</Text>
          <Text style={styles.subtitle}>
            {user?.username} · {user?.email}
          </Text>

          <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
            <Text style={styles.section}>Nom affiché</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.rowInput]}
                value={displayName}
                onChangeText={setDisplayName}
                maxLength={60}
              />
              <Pressable
                style={[styles.actionBtn, busyName && styles.btnDisabled]}
                disabled={busyName}
                onPress={saveName}
              >
                <Text style={styles.actionBtnText}>{busyName ? "…" : "Enregistrer"}</Text>
              </Pressable>
            </View>

            <View style={styles.divider} />

            <Text style={styles.section}>Changer de mot de passe</Text>
            <TextInput
              style={styles.input}
              placeholder="Mot de passe actuel"
              secureTextEntry
              value={currentPassword}
              onChangeText={setCurrentPassword}
            />
            <TextInput
              style={styles.input}
              placeholder="Nouveau mot de passe"
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <TextInput
              style={styles.input}
              placeholder="Confirmation"
              secureTextEntry
              value={newPassword2}
              onChangeText={setNewPassword2}
            />
            <Pressable
              style={[styles.fullBtn, busyPwd && styles.btnDisabled]}
              disabled={busyPwd}
              onPress={savePassword}
            >
              <Text style={styles.fullBtnText}>
                {busyPwd ? "…" : "Mettre à jour le mot de passe"}
              </Text>
            </Pressable>

            {error && <Text style={styles.error}>{error}</Text>}
            {info && <Text style={styles.info}>{info}</Text>}
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
  section: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    color: colors.text,
  },
  rowInput: { flex: 1, marginBottom: 0 },
  actionBtn: {
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  actionBtnText: { color: colors.white, fontWeight: "600" },
  fullBtn: {
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 4,
  },
  fullBtnText: { color: colors.white, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 16,
  },
  error: { color: colors.red, fontSize: 13, marginTop: 10 },
  info: { color: "#16A34A", fontSize: 13, marginTop: 10 },
  footer: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
  closeBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  closeBtnText: { color: colors.text, fontWeight: "600" },
});
