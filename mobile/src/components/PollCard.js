import { useRef, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, Platform } from "react-native";
import { api } from "../api";
import { colors } from "../theme";
import {
  POLL_OPTION_MAX,
  canAddOption,
  myOptionIds,
  nextSelection,
  optionPercent,
  pollErrorMessage,
  sameOption,
  voterCountLabel,
  votersLabel,
} from "../polls";

// Carte d'un sondage, à la place du corps du message (son texte de repli
// « 📊 Sondage : … »). Toucher une réponse vote ; un appui long déroule la liste
// complète de ses votants, comme pour les réactions. Chaque action renvoie le
// sondage à jour, passé à `onPollUpdate` comme l'évènement `poll:update`.
// `canModerate` : admin du salon ou du chat, qui peut clôturer le sondage d'un autre.
export default function PollCard({ message, currentUser, canModerate, onPollUpdate }) {
  const poll = message.poll;
  const me = currentUser?.id;
  const isAuthor = message.author?.id === me;
  const closed = !!poll.closedAt;
  const mine = myOptionIds(poll, me);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(null); // id de la réponse dont on voit tous les votants
  // Garde synchrone : deux touchers rapides arrivent avant que `busy` ne soit rendu,
  // et enverraient deux sélections contradictoires.
  const inFlight = useRef(false);

  async function run(action, fallback) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      onPollUpdate?.(await action());
      return true;
    } catch (e) {
      setError(pollErrorMessage(e, fallback));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function vote(optionId) {
    if (closed) return;
    run(() => api.votePoll(poll.id, nextSelection(poll, me, optionId)), "Vote impossible.");
  }

  async function addOption() {
    const text = draft.trim().replace(/\s+/g, " ");
    if (!text) return;
    if (text.length > POLL_OPTION_MAX) {
      setError(`Une réponse ne dépasse pas ${POLL_OPTION_MAX} caractères.`);
      return;
    }
    if (poll.options.some((o) => sameOption(o.text, text))) {
      setError("Cette réponse existe déjà.");
      return;
    }
    const ok = await run(() => api.addPollOption(poll.id, text), "Ajout impossible.");
    if (ok) setDraft("");
  }

  function close() {
    run(() => api.closePoll(poll.id), "Clôture impossible.");
  }

  function confirmClose() {
    const title = "Clôturer le sondage ?";
    const detail = "Plus personne ne pourra voter ni ajouter de réponse. Les résultats restent visibles.";
    // L'export web (vérifications Playwright) n'a pas d'Alert à boutons.
    if (Platform.OS === "web") {
      if (globalThis.confirm?.(`${title}\n${detail}`)) close();
      return;
    }
    Alert.alert(title, detail, [
      { text: "Annuler", style: "cancel" },
      { text: "Clôturer", style: "destructive", onPress: close },
    ]);
  }

  return (
    <View style={styles.card}>
      <Text style={styles.question}>📊 {poll.question}</Text>
      <View style={styles.metaRow}>
        <Text style={styles.meta}>{poll.multiple ? "Choix multiple" : "Choix unique"}</Text>
        {closed && (
          <View style={styles.closedBadge}>
            <Text style={styles.closedBadgeText}>Clôturé</Text>
          </View>
        )}
      </View>

      {poll.options.map((o) => {
        const checked = mine.includes(o.id);
        const pct = optionPercent(poll, o);
        const showAll = expanded === o.id;
        return (
          <Pressable
            key={o.id}
            onPress={closed ? undefined : () => vote(o.id)}
            onLongPress={() => setExpanded(showAll ? null : o.id)}
            delayLongPress={300}
            accessibilityRole={poll.multiple ? "checkbox" : "radio"}
            accessibilityState={{ checked, disabled: closed || busy }}
            style={({ pressed }) => [
              styles.option,
              checked && styles.optionMine,
              pressed && !closed && styles.optionPressed,
              busy && styles.optionBusy,
            ]}
          >
            <View style={styles.optionTop}>
              {!closed && (
                <View
                  style={[
                    poll.multiple ? styles.box : styles.radio,
                    checked && styles.indicatorOn,
                  ]}
                >
                  {checked &&
                    (poll.multiple ? (
                      <Text style={styles.tick}>✓</Text>
                    ) : (
                      <View style={styles.dot} />
                    ))}
                </View>
              )}
              <Text style={[styles.optionText, checked && styles.optionTextMine]}>
                {o.text}
                {closed && checked ? "  ✓" : ""}
              </Text>
              <Text style={styles.count}>
                {o.count} · {pct}{" "}%
              </Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, checked && styles.fillMine, { width: `${pct}%` }]} />
            </View>
            {o.count > 0 && (
              <Text style={styles.voters} numberOfLines={showAll ? undefined : 1}>
                {votersLabel(o.voters, showAll)}
              </Text>
            )}
          </Pressable>
        );
      })}

      {canAddOption(poll, isAuthor) && (
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            placeholder="Ajouter une réponse…"
            placeholderTextColor={colors.textMuted}
            value={draft}
            onChangeText={(t) => {
              setDraft(t);
              if (error) setError(null);
            }}
            maxLength={POLL_OPTION_MAX}
            returnKeyType="done"
            onSubmitEditing={addOption}
            editable={!busy}
          />
          <Pressable
            style={[styles.addBtn, (!draft.trim() || busy) && styles.btnDisabled]}
            onPress={addOption}
            disabled={!draft.trim() || busy}
          >
            <Text style={styles.addBtnText}>Ajouter</Text>
          </Pressable>
        </View>
      )}

      {!!error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          {voterCountLabel(poll.voterCount)}
          {!closed && mine.length === 0 ? " · touchez une réponse pour voter" : ""}
        </Text>
        {!closed && (isAuthor || canModerate) && (
          <Pressable onPress={confirmClose} disabled={busy} hitSlop={6}>
            <Text style={[styles.closeText, busy && styles.btnDisabled]}>Clôturer le sondage</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 4,
    marginRight: 18, // laisse la place au bouton ⋯ du message
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    backgroundColor: colors.white,
    gap: 6,
  },
  question: { fontWeight: "700", fontSize: 15, color: colors.text, lineHeight: 20 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  meta: { fontSize: 12, color: colors.textMuted },
  closedBadge: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  closedBadgeText: { fontSize: 11, fontWeight: "700", color: colors.textMuted },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 5,
  },
  optionMine: { borderColor: colors.aubergine, backgroundColor: colors.aubergineTint },
  optionPressed: { opacity: 0.7 },
  optionBusy: { opacity: 0.6 },
  optionTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  box: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  indicatorOn: { borderColor: colors.aubergine, backgroundColor: colors.white },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.aubergine },
  tick: { color: colors.aubergine, fontSize: 12, fontWeight: "900", lineHeight: 14 },
  optionText: { flex: 1, color: colors.text, fontSize: 14 },
  optionTextMine: { fontWeight: "700", color: colors.aubergine },
  count: { color: colors.textMuted, fontSize: 12, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: 3, backgroundColor: "#EEEEEE", overflow: "hidden" },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.aubergineMuted },
  fillMine: { backgroundColor: colors.aubergine },
  voters: { fontSize: 11, color: colors.textMuted, fontStyle: "italic" },
  addRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    color: colors.text,
    fontSize: 14,
  },
  addBtn: { backgroundColor: colors.aubergine, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  addBtnText: { color: colors.white, fontWeight: "600", fontSize: 13 },
  btnDisabled: { opacity: 0.5 },
  error: { color: colors.red, fontSize: 12 },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 2,
  },
  footerText: { flexShrink: 1, fontSize: 12, color: colors.textMuted },
  closeText: { fontSize: 12, fontWeight: "700", color: colors.red },
});
