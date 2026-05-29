import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, AppState, StyleSheet } from "react-native";
import { checkForUpdate } from "../version";
import { colors } from "../theme";

// Info-only update banner (per product decision, mobile just informs — no
// download action). Checks on mount, whenever the app returns to foreground,
// and every 15 min. Dismissible per advertised version.
export default function UpdateBanner() {
  const [latest, setLatest] = useState(null); // version string if an update is available
  const [dismissed, setDismissed] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const run = () =>
      checkForUpdate().then((info) => {
        if (mounted.current && info?.updateAvailable) setLatest(info.latest);
      });
    run();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") run();
    });
    const iv = setInterval(run, 15 * 60 * 1000);
    return () => {
      mounted.current = false;
      sub.remove();
      clearInterval(iv);
    };
  }, []);

  if (!latest || latest === dismissed) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text} numberOfLines={2}>
        Nouvelle version disponible ({latest}). Mettez à jour depuis le store / l'installeur.
      </Text>
      <Pressable onPress={() => setDismissed(latest)} hitSlop={10}>
        <Text style={styles.close}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#FEF3C7",
    borderTopWidth: 1,
    borderTopColor: "#FCD34D",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  text: { flex: 1, color: "#92400E", fontSize: 13, fontWeight: "600" },
  close: { color: "#92400E", fontSize: 16, fontWeight: "700" },
});
