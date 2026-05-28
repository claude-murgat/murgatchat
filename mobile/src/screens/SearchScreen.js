import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { api } from "../api";
import { colors } from "../theme";

// `<mark>` tags from ts_headline are stripped (we don't render HTML on mobile).
// Cheap regex: ts_headline always emits balanced tags so the strip is safe.
function plainSnippet(s) {
  return typeof s === "string" ? s.replace(/<\/?mark>/gi, "") : "";
}

export default function SearchScreen({ navigation }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.search({ q: term });
        if (seq !== seqRef.current) return;
        setResults(res.results || []);
      } catch {
        if (seq === seqRef.current) setResults([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  function renderItem({ item }) {
    const channelLabel = item.channel?.isDirect
      ? `@${item.author?.username || "?"}`
      : `#${item.channel?.name || "?"}`;
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
    return (
      <Pressable
        style={styles.row}
        onPress={() => {
          // Open the source channel; scrolling to the exact message would require
          // a channel-level ref and is left for a follow-up.
          navigation.navigate("Channel", { channelId: item.channelId });
        }}
      >
        <Text style={styles.meta}>
          <Text style={styles.metaChannel}>{channelLabel}</Text>
          {"  ·  "}
          <Text>{item.author?.displayName || "?"}</Text>
          {"  ·  "}
          <Text>{when}</Text>
        </Text>
        <Text style={styles.body} numberOfLines={3}>
          {plainSnippet(item.snippet)}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Text style={styles.icon}>🔍</Text>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="Rechercher dans toutes vos conversations…"
          autoCapitalize="none"
          autoCorrect={false}
          value={q}
          onChangeText={setQ}
          returnKeyType="search"
        />
      </View>
      {loading && (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.aubergine} />
        </View>
      )}
      {!loading && q.trim() && results.length === 0 && (
        <Text style={styles.empty}>Aucun résultat.</Text>
      )}
      <FlatList
        data={results}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  icon: { fontSize: 18, color: colors.textMuted },
  input: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 8 },
  loading: { padding: 14, alignItems: "center" },
  empty: { padding: 20, textAlign: "center", color: colors.textMuted },
  row: { padding: 12, backgroundColor: colors.white },
  meta: { fontSize: 12, color: colors.textMuted, marginBottom: 4 },
  metaChannel: { color: colors.aubergine, fontWeight: "700" },
  body: { fontSize: 14, color: colors.text },
  sep: { height: 1, backgroundColor: colors.border },
});
