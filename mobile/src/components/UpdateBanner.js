import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, AppState, StyleSheet } from "react-native";
import { checkForUpdate, downloadAndInstallApk } from "../version";

// Update banner. Checks on mount, whenever the app returns to foreground, and
// every 15 min. Dismissible per advertised version.
//  - APK publiée plus récente (manifeste android.json de la release) : bouton
//    « Installer » → téléchargement, puis installeur d'Android, sans passer par
//    le navigateur ;
//  - sinon (le serveur annonce une version dont l'APK n'est pas encore publiée) :
//    simple information.
export default function UpdateBanner() {
  const [update, setUpdate] = useState(null); // { latest, apk } si une mise à jour existe
  const [dismissed, setDismissed] = useState(null);
  const [progress, setProgress] = useState(null); // null, ou 0 → 1 pendant le téléchargement
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  const busy = progress !== null;
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    mounted.current = true;
    const run = () =>
      checkForUpdate().then((info) => {
        // Pas de nouvelle vérification pendant un téléchargement : le bandeau
        // garderait sa version, mais on évite d'en changer en cours de route.
        if (!mounted.current || busyRef.current) return;
        setUpdate(info?.updateAvailable ? { latest: info.latest, apk: info.apk } : null);
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

  if (!update || update.latest === dismissed) return null;

  async function install() {
    setError(null);
    setProgress(0);
    try {
      await downloadAndInstallApk(update.apk, (f) => mounted.current && setProgress(f));
    } catch (e) {
      if (mounted.current) setError(e?.message || String(e));
    } finally {
      if (mounted.current) setProgress(null);
    }
  }

  let text;
  if (busy) text = `Téléchargement de la version ${update.latest}… ${Math.round(progress * 100)} %`;
  else if (error) text = `Mise à jour impossible : ${error}. Réessayez.`;
  else if (update.apk) text = `Nouvelle version disponible (${update.latest}).`;
  else text = `Nouvelle version disponible (${update.latest}), bientôt installable ici.`;

  return (
    <View style={styles.banner}>
      <Text style={styles.text} numberOfLines={2}>
        {text}
      </Text>
      {update.apk && !busy && (
        <Pressable onPress={install} style={styles.button} hitSlop={6}>
          <Text style={styles.buttonText}>Installer</Text>
        </Pressable>
      )}
      {!busy && (
        <Pressable onPress={() => setDismissed(update.latest)} hitSlop={10}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      )}
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
  button: {
    backgroundColor: "#D97706",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  buttonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  close: { color: "#92400E", fontSize: 16, fontWeight: "700" },
});
