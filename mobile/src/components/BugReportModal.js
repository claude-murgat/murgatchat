import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api";
import { getDiagnostics, getLogLines, dumpText, entryCount } from "../logbuffer";
import { colors } from "../theme";

// "Signaler un bug" for mobile. Lets the user describe the problem and optionally
// attach the captured diagnostic logs (stored server-side for admins). App
// version + platform always go along; detailed logs only when the box is ticked.
export default function BugReportModal({ visible, onClose }) {
  const [message, setMessage] = useState("");
  const [attachLogs, setAttachLogs] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  // Snapshot diagnostics + logs each time the modal opens, and reset the form.
  useEffect(() => {
    if (visible) {
      setSnapshot({
        diagnostics: getDiagnostics(),
        logs: getLogLines(),
        text: dumpText(),
        count: entryCount(),
      });
      setMessage("");
      setAttachLogs(true);
      setShowPreview(false);
      setError(null);
      setDone(false);
      setCopied(false);
    }
  }, [visible]);

  async function copyLogs() {
    if (!snapshot) return;
    try {
      await Clipboard.setStringAsync(snapshot.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copie impossible.");
    }
  }

  async function submit() {
    const text = message.trim();
    if (!text) {
      setError("Décrivez le problème avant d'envoyer.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.reportBug({
        message: text,
        appVersion: snapshot?.diagnostics.appVersion,
        platform: snapshot?.diagnostics.platform,
        ...(attachLogs && snapshot
          ? { logs: snapshot.logs, diagnostics: snapshot.diagnostics }
          : {}),
      });
      setDone(true);
    } catch (e) {
      setError(e?.data?.error || e?.message || "Échec de l'envoi — réessayez.");
    } finally {
      setBusy(false);
    }
  }

  const count = snapshot?.count || 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>🐞 Signaler un bug</Text>
          <Text style={styles.subtitle}>
            Décrivez ce qui s'est passé. Les logs aident à diagnostiquer plus vite.
          </Text>

          {done ? (
            <View style={styles.doneBox}>
              <Text style={styles.doneEmoji}>✅</Text>
              <Text style={styles.doneTitle}>Merci, votre rapport a été envoyé.</Text>
              <Pressable style={styles.fullBtn} onPress={onClose}>
                <Text style={styles.fullBtnText}>Fermer</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
                <TextInput
                  style={styles.textarea}
                  value={message}
                  onChangeText={setMessage}
                  placeholder="Ex. : en ouvrant un salon, l'app reste bloquée…"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  numberOfLines={5}
                  textAlignVertical="top"
                />

                <Pressable
                  style={styles.checkRow}
                  onPress={() => setAttachLogs((v) => !v)}
                >
                  <View style={[styles.checkbox, attachLogs && styles.checkboxOn]}>
                    {attachLogs && <Text style={styles.checkMark}>✓</Text>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.checkLabel}>
                      Joindre les logs de diagnostic ({count} ligne
                      {count > 1 ? "s" : ""})
                    </Text>
                    <Text style={styles.checkHint}>
                      Événements techniques et infos appareil. Aucun contenu de message
                      n'est inclus. Version et plateforme toujours jointes.
                    </Text>
                  </View>
                </Pressable>

                <View style={styles.btnRow}>
                  <Pressable
                    style={styles.outlineBtn}
                    onPress={() => setShowPreview((s) => !s)}
                  >
                    <Text style={styles.outlineBtnText}>
                      {showPreview ? "Masquer l'aperçu" : "Voir ce qui sera envoyé"}
                    </Text>
                  </Pressable>
                  <Pressable style={styles.outlineBtn} onPress={copyLogs}>
                    <Text style={styles.outlineBtnText}>
                      {copied ? "Copié ✓" : "Copier les logs"}
                    </Text>
                  </Pressable>
                </View>

                {showPreview && snapshot && (
                  <ScrollView style={styles.preview} nestedScrollEnabled>
                    <Text style={styles.previewText}>{snapshot.text}</Text>
                  </ScrollView>
                )}

                {error && <Text style={styles.error}>{error}</Text>}
              </ScrollView>

              <View style={styles.footer}>
                <Pressable style={styles.closeBtn} onPress={onClose} disabled={busy}>
                  <Text style={styles.closeBtnText}>Annuler</Text>
                </Pressable>
                <Pressable
                  style={[styles.sendBtn, (busy || !message.trim()) && styles.btnDisabled]}
                  onPress={submit}
                  disabled={busy || !message.trim()}
                >
                  <Text style={styles.sendBtnText}>{busy ? "Envoi…" : "Envoyer"}</Text>
                </Pressable>
              </View>
            </>
          )}
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
  card: { backgroundColor: colors.white, borderRadius: 12, padding: 20, maxHeight: "90%" },
  title: { fontSize: 20, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 4, marginBottom: 14 },
  textarea: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    minHeight: 110,
    color: colors.text,
  },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 14 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.aubergine, borderColor: colors.aubergine },
  checkMark: { color: colors.white, fontSize: 14, fontWeight: "700" },
  checkLabel: { fontSize: 14, fontWeight: "600", color: colors.text },
  checkHint: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" },
  outlineBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  outlineBtnText: { color: colors.text, fontSize: 13 },
  preview: {
    marginTop: 12,
    maxHeight: 180,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 8,
  },
  previewText: { fontSize: 11, color: "#334155", fontFamily: "monospace" },
  error: { color: colors.red, fontSize: 13, marginTop: 10 },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  closeBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  closeBtnText: { color: colors.text, fontWeight: "600" },
  sendBtn: {
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    justifyContent: "center",
  },
  sendBtnText: { color: colors.white, fontWeight: "600" },
  btnDisabled: { opacity: 0.5 },
  fullBtn: {
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 16,
    alignSelf: "stretch",
  },
  fullBtnText: { color: colors.white, fontWeight: "600" },
  doneBox: { alignItems: "center", paddingVertical: 24 },
  doneEmoji: { fontSize: 40 },
  doneTitle: { fontSize: 15, fontWeight: "600", color: colors.text, marginTop: 10, textAlign: "center" },
});
