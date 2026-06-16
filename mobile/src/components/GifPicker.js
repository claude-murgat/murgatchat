import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
} from "react-native";
import { Image } from "expo-image";
import { api } from "../api";
import { colors } from "../theme";

const COLS = 2;
const GAP = 6;

// GIF search/browse sheet. Trending on open, debounced search as you type.
// Tapping a GIF calls onSelect(gif) — the Composer imports + sends it. Previews
// load from GIPHY's CDN; only the chosen GIF is re-hosted server-side.
export default function GifPicker({ visible, onSelect, onClose }) {
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [nextPos, setNextPos] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const seq = useRef(0);

  const cellW = Math.floor((Dimensions.get("window").width - GAP * (COLS + 1)) / COLS);

  async function load(query, pos, append) {
    const s = ++seq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.gifSearch({ q: query, pos });
      if (s !== seq.current) return;
      setNotConfigured(false);
      setGifs((prev) => (append ? [...prev, ...res.gifs] : res.gifs));
      setNextPos(res.nextPos || 0);
      setHasMore((res.gifs?.length || 0) >= 24);
    } catch (e) {
      if (s !== seq.current) return;
      if (e?.status === 503 || e?.data?.error === "not_configured") {
        setNotConfigured(true);
        setGifs([]);
      } else {
        setError("GIF indisponibles pour le moment.");
      }
    } finally {
      if (s === seq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => load(q.trim(), 0, false), q ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, q]);

  function renderItem({ item }) {
    return (
      <Pressable onPress={() => onSelect(item)} style={{ margin: GAP / 2 }}>
        <Image
          source={{ uri: item.previewUrl }}
          style={{ width: cellW, height: cellW * 0.8, borderRadius: 8, backgroundColor: colors.border }}
          contentFit="cover"
        />
      </Pressable>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TextInput
            style={styles.search}
            placeholder="Rechercher un GIF…"
            placeholderTextColor={colors.textMuted}
            value={q}
            onChangeText={setQ}
            autoFocus
            autoCorrect={false}
          />
          <Pressable onPress={onClose} style={styles.cancel}>
            <Text style={styles.cancelText}>Fermer</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.aubergine} />
          </View>
        ) : notConfigured ? (
          <View style={styles.center}>
            <Text style={styles.muted}>Recherche de GIF non configurée.</Text>
            <Text style={styles.mutedSmall}>Définissez GIPHY_API_KEY côté serveur.</Text>
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : (
          <FlatList
            data={gifs}
            keyExtractor={(g) => g.id}
            renderItem={renderItem}
            numColumns={COLS}
            contentContainerStyle={{ padding: GAP / 2 }}
            onEndReached={() => {
              if (hasMore && !loadingMore) load(q.trim(), nextPos, true);
            }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={<Text style={[styles.muted, { padding: 20 }]}>Aucun résultat.</Text>}
            ListFooterComponent={
              loadingMore ? (
                <View style={{ padding: 12 }}>
                  <ActivityIndicator color={colors.aubergine} />
                </View>
              ) : null
            }
            keyboardShouldPersistTaps="handled"
          />
        )}

        <Text style={styles.attribution}>Powered by GIPHY</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: 44 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  search: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    backgroundColor: colors.white,
  },
  cancel: { paddingHorizontal: 6, paddingVertical: 8 },
  cancelText: { color: colors.aubergine, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  muted: { color: colors.textMuted, textAlign: "center" },
  mutedSmall: { color: colors.textMuted, fontSize: 12, marginTop: 4, textAlign: "center" },
  error: { color: colors.red, textAlign: "center" },
  attribution: {
    textAlign: "center",
    color: colors.textMuted,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    paddingVertical: 6,
  },
});
