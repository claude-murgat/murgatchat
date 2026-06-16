import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  Alert,
} from "react-native";
import { Image } from "expo-image";
import { Video, ResizeMode } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { attachmentUrl } from "../api";
import { fmtBytes } from "../format";
import { colors } from "../theme";

function kindOf(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "other"; // pdf + everything else → download/open externally
}

// Keep the cache filename predictable + filesystem-safe.
function safeName(name) {
  return (name || "fichier").replace(/[^\w.\- ]+/g, "_").slice(0, 100);
}

// Full-screen preview for a single attachment. Image/video play in-app; audio
// uses the native media controls; PDFs and other types are downloaded and handed
// to the OS (share sheet → open in a viewer / save), since Android's WebView
// can't render them inline.
export default function AttachmentModal({ attachment, visible, onClose }) {
  const [busy, setBusy] = useState(false);
  if (!attachment) return null;

  const url = attachmentUrl(attachment.id); // carries ?token=…
  const kind = kindOf(attachment.mimeType);

  async function downloadAndShare() {
    setBusy(true);
    try {
      const target = FileSystem.cacheDirectory + safeName(attachment.filename);
      const { uri } = await FileSystem.downloadAsync(url, target);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: attachment.mimeType || "application/octet-stream",
          dialogTitle: attachment.filename,
        });
      } else {
        Alert.alert("Téléchargé", `Fichier enregistré :\n${uri}`);
      }
    } catch (e) {
      Alert.alert("Erreur", e?.message || "Téléchargement impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {attachment.filename}
            <Text style={styles.size}> · {fmtBytes(attachment.size)}</Text>
          </Text>
          <Pressable onPress={downloadAndShare} disabled={busy} style={styles.dlBtn}>
            <Text style={styles.dlText}>{busy ? "…" : "⬇ Télécharger"}</Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        <Pressable style={styles.body} onPress={onClose}>
          <Pressable style={styles.bodyInner} onPress={() => {}}>
            {kind === "image" && (
              <Image source={{ uri: url }} style={styles.image} contentFit="contain" />
            )}
            {kind === "video" && (
              <Video
                source={{ uri: url }}
                style={styles.video}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay
              />
            )}
            {kind === "audio" && (
              <View style={styles.card}>
                <Text style={styles.cardIcon}>🎵</Text>
                <Text style={styles.cardName} numberOfLines={2}>
                  {attachment.filename}
                </Text>
                <Video
                  source={{ uri: url }}
                  style={styles.audio}
                  useNativeControls
                  resizeMode={ResizeMode.CONTAIN}
                  shouldPlay
                />
              </View>
            )}
            {kind === "other" && (
              <View style={styles.card}>
                <Text style={styles.cardIcon}>📄</Text>
                <Text style={styles.cardName} numberOfLines={2}>
                  {attachment.filename}
                </Text>
                <Text style={styles.cardSize}>{fmtBytes(attachment.size)}</Text>
                <Text style={styles.cardHint}>
                  Aperçu indisponible dans l'app — ouvrez-le avec une autre application.
                </Text>
                <Pressable onPress={downloadAndShare} disabled={busy} style={styles.cardBtn}>
                  <Text style={styles.cardBtnText}>
                    {busy ? "…" : "Ouvrir / Télécharger"}
                  </Text>
                </Pressable>
              </View>
            )}
          </Pressable>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.9)" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 44,
    paddingBottom: 10,
  },
  title: { flex: 1, color: colors.white, fontSize: 13 },
  size: { color: "rgba(255,255,255,0.6)" },
  dlBtn: { backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  dlText: { color: colors.white, fontWeight: "600", fontSize: 13 },
  closeBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  closeText: { color: colors.white, fontSize: 20 },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 12 },
  bodyInner: { width: "100%", alignItems: "center", justifyContent: "center" },
  image: { width: "100%", height: "100%", maxHeight: "100%" },
  video: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000" },
  audio: { width: "100%", height: 60, marginTop: 12 },
  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    maxWidth: 340,
    width: "90%",
  },
  cardIcon: { fontSize: 48, marginBottom: 8 },
  cardName: { fontWeight: "600", color: colors.text, textAlign: "center" },
  cardSize: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  cardHint: { color: colors.textMuted, fontSize: 13, textAlign: "center", marginTop: 12 },
  cardBtn: {
    marginTop: 16,
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  cardBtnText: { color: colors.white, fontWeight: "600" },
});
