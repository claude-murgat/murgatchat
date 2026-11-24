import { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ScrollView,
  Switch,
  StyleSheet,
} from "react-native";
import { api } from "../api";
import { colors } from "../theme";
import {
  POLL_OPTION_MAX,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_QUESTION_MAX,
  pollErrorMessage,
  validatePollDraft,
} from "../polls";

// Chaque réponse garde une clé stable : retirer celle du milieu ne fait pas
// glisser le texte ni le focus d'un champ à l'autre.
let nextKey = 0;
const newOption = () => ({ key: `o${nextKey++}`, text: "" });
const EMPTY = () => ({
  question: "",
  options: [newOption(), newOption()],
  multiple: false,
  allowAddOptions: false,
});

// « Nouveau sondage » dans un salon : une question, 2 à 20 réponses, choix
// unique ou multiple, et si les membres peuvent ajouter des réponses. Le message
// publié revient aussi par `message:new` : `onCreated` reçoit celui de la
// réponse HTTP, que l'écran dédoublonne par id. Fermer sans publier garde le
// brouillon (un toucher à côté de la carte ne fait rien perdre).
export default function PollModal({ visible, channelId, onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Deux touchers rapides sur « Publier » arrivent avant que `busy` ne soit
  // rendu : sans ce verrou, le salon recevrait deux sondages identiques.
  const inFlight = useRef(false);

  const update = (fn) => {
    setForm((f) => ({ ...f, ...fn(f) }));
    setError(null);
  };
  const set = (patch) => update(() => patch);
  const setOption = (key, text) =>
    update((f) => ({ options: f.options.map((o) => (o.key === key ? { ...o, text } : o)) }));
  const removeOption = (key) => update((f) => ({ options: f.options.filter((o) => o.key !== key) }));
  const addOption = () => update((f) => ({ options: [...f.options, newOption()] }));

  async function publish() {
    if (inFlight.current) return;
    const checked = validatePollDraft({
      question: form.question,
      options: form.options.map((o) => o.text),
    });
    if (checked.error) {
      setError(checked.error);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createPoll({
        channelId,
        question: checked.question,
        options: checked.options,
        multiple: form.multiple,
        allowAddOptions: form.allowAddOptions,
      });
      onCreated?.(res.message);
      setForm(EMPTY());
      onClose();
    } catch (e) {
      setError(
        e?.data?.error === "duplicate_option"
          ? "Deux réponses sont identiques."
          : pollErrorMessage(e, "Publication impossible.")
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>Nouveau sondage</Text>

          <ScrollView
            contentContainerStyle={{ paddingBottom: 8 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.section}>Question</Text>
            <TextInput
              style={[styles.input, styles.questionInput]}
              placeholder="Que voulez-vous demander ?"
              placeholderTextColor={colors.textMuted}
              value={form.question}
              onChangeText={(question) => set({ question })}
              maxLength={POLL_QUESTION_MAX}
              multiline
            />

            <Text style={styles.section}>
              Réponses ({form.options.length}/{POLL_OPTIONS_MAX})
            </Text>
            {form.options.map(({ key, text }, i) => (
              <View key={key} style={styles.optionRow}>
                <TextInput
                  style={[styles.input, styles.optionInput]}
                  placeholder={`Réponse ${i + 1}`}
                  placeholderTextColor={colors.textMuted}
                  value={text}
                  onChangeText={(t) => setOption(key, t)}
                  maxLength={POLL_OPTION_MAX}
                />
                {form.options.length > POLL_OPTIONS_MIN && (
                  <Pressable
                    style={styles.removeBtn}
                    onPress={() => removeOption(key)}
                    hitSlop={6}
                    accessibilityLabel={`Retirer la réponse ${i + 1}`}
                  >
                    <Text style={styles.removeText}>✕</Text>
                  </Pressable>
                )}
              </View>
            ))}
            {form.options.length < POLL_OPTIONS_MAX && (
              <Pressable onPress={addOption} style={styles.addLink}>
                <Text style={styles.addLinkText}>+ Ajouter une réponse</Text>
              </Pressable>
            )}

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Plusieurs réponses possibles</Text>
              <Switch
                value={form.multiple}
                onValueChange={(multiple) => set({ multiple })}
                trackColor={{ true: colors.aubergineLight, false: colors.border }}
                thumbColor={form.multiple ? colors.aubergine : "#F4F4F4"}
              />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Les membres peuvent ajouter des réponses</Text>
              <Switch
                value={form.allowAddOptions}
                onValueChange={(allowAddOptions) => set({ allowAddOptions })}
                trackColor={{ true: colors.aubergineLight, false: colors.border }}
                thumbColor={form.allowAddOptions ? colors.aubergine : "#F4F4F4"}
              />
            </View>

            {!!error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelBtnText}>Annuler</Text>
            </Pressable>
            <Pressable
              style={[styles.publishBtn, busy && styles.btnDisabled]}
              onPress={publish}
              disabled={busy}
            >
              <Text style={styles.publishBtnText}>{busy ? "…" : "Publier"}</Text>
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
  title: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 14 },
  section: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
  },
  questionInput: { minHeight: 64, textAlignVertical: "top", marginBottom: 14 },
  optionRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  optionInput: { flex: 1 },
  removeBtn: { paddingHorizontal: 6, paddingVertical: 8 },
  removeText: { color: colors.textMuted, fontSize: 16 },
  addLink: { paddingVertical: 6, marginBottom: 10 },
  addLinkText: { color: colors.aubergine, fontWeight: "600" },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  switchLabel: { flex: 1, color: colors.text, fontSize: 14 },
  error: { color: colors.red, fontSize: 13, marginTop: 10 },
  footer: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 12 },
  cancelBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  cancelBtnText: { color: colors.text, fontWeight: "600" },
  publishBtn: { backgroundColor: colors.aubergine, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 9 },
  publishBtnText: { color: colors.white, fontWeight: "700" },
  btnDisabled: { opacity: 0.5 },
});
