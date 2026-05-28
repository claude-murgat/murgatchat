import { useEffect, useRef, useState } from "react";

const PAGE_SIZE = 50;
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useChat } from "../ChatContext";
import { api } from "../api";
import Avatar from "../components/Avatar";
import { colors } from "../theme";

// Mirror of web/src/components/AdminPanelModal.jsx: owner > admin > member,
// with field-level permission checks driving which actions are offered.
function actionsFor(me, target) {
  if (target.id === me.id) return [];
  if (target.isOwner) return [];

  const out = [];
  if (me.isOwner) {
    out.push(
      target.isAdmin
        ? { key: "revoke", label: "Révoquer admin" }
        : { key: "promote", label: "Promouvoir admin" }
    );
  }
  if (target.status === "disabled") {
    out.push({ key: "enable", label: "Réactiver" });
  } else if (!target.isAdmin || me.isOwner) {
    out.push({ key: "disable", label: "Désactiver", danger: true });
  }
  if (me.isOwner && target.status !== "disabled") {
    out.push({ key: "transfer", label: "Transférer", danger: true });
  }
  return out;
}

export default function AdminPanelScreen({ navigation }) {
  const { user, setUser } = useChat();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [busyId, setBusyId] = useState(null);
  // Same anti-stale-response guard as web: discard a fetch if a newer one has
  // since been issued (rapid typing or fast scroll).
  const fetchSeq = useRef(0);

  async function fetchPage({ p, q, append }) {
    const seq = ++fetchSeq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const res = await api.listAdminUsers({ page: p, pageSize: PAGE_SIZE, q });
      if (seq !== fetchSeq.current) return;
      setUsers((prev) => (append ? [...prev, ...res.users] : res.users));
      setHasMore(res.hasMore);
      setTotal(res.total);
      setPage(p);
    } catch (e) {
      if (seq === fetchSeq.current) Alert.alert("Erreur", e.message || "Chargement impossible");
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  // Debounced server-side search.
  useEffect(() => {
    const t = setTimeout(() => fetchPage({ p: 1, q: query.trim(), append: false }), 300);
    return () => clearTimeout(t);
  }, [query]);

  function loadMore() {
    if (!hasMore || loadingMore) return;
    fetchPage({ p: page + 1, q: query.trim(), append: true });
  }

  async function refreshCurrentView() {
    // Re-fetch the rows currently visible so a transfer / role change is
    // reflected without sending the user back to the top of the list.
    const seq = ++fetchSeq.current;
    try {
      const res = await api.listAdminUsers({
        page: 1,
        pageSize: page * PAGE_SIZE,
        q: query.trim(),
      });
      if (seq !== fetchSeq.current) return;
      setUsers(res.users);
      setHasMore(res.hasMore);
      setTotal(res.total);
    } catch {
      /* ignore */
    }
  }

  async function runAction(target, action) {
    setBusyId(target.id);
    try {
      let res;
      if (action === "promote") res = await api.patchUser(target.id, { isAdmin: true });
      else if (action === "revoke") res = await api.patchUser(target.id, { isAdmin: false });
      else if (action === "disable")
        res = await api.patchUser(target.id, { status: "disabled" });
      else if (action === "enable")
        res = await api.patchUser(target.id, { status: "active" });
      else if (action === "transfer") {
        await api.transferOwnership(target.id);
        await refreshCurrentView();
        // Current user lost ownership: refresh /auth/me so the UI updates.
        const me = (await api.me()).user;
        setUser(me);
        return;
      }
      if (res?.user) {
        setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)));
        if (res.user.id === user.id) setUser(res.user);
      }
    } catch (e) {
      Alert.alert("Erreur", e.data?.error || e.message || "Action refusée");
    } finally {
      setBusyId(null);
    }
  }

  function requestAction(target, action) {
    if (action !== "disable" && action !== "transfer") {
      runAction(target, action);
      return;
    }
    const message =
      action === "disable"
        ? `Désactiver ${target.displayName} ? L'utilisateur ne pourra plus se connecter ni accéder aux conversations. Son historique de messages est conservé.`
        : `Transférer la propriété à ${target.displayName} ? Vous deviendrez simple administrateur ; seul le nouveau propriétaire pourra vous rendre la propriété.`;
    Alert.alert("Confirmer", message, [
      { text: "Annuler", style: "cancel" },
      {
        text: action === "transfer" ? "Transférer" : "Désactiver",
        style: "destructive",
        onPress: () => runAction(target, action),
      },
    ]);
  }

  function renderItem({ item: u }) {
    const actions = actionsFor(user, u);
    const disabled = u.status === "disabled";
    return (
      <View style={styles.row}>
        <Avatar user={u} size={36} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.nameRow}>
            <Text
              style={[styles.name, disabled && styles.nameDisabled]}
              numberOfLines={1}
            >
              {u.displayName}
            </Text>
            {u.isOwner ? (
              <Text style={[styles.badge, styles.badgeOwner]}>Propriétaire</Text>
            ) : u.isAdmin ? (
              <Text style={[styles.badge, styles.badgeAdmin]}>Admin</Text>
            ) : null}
            {disabled && (
              <Text style={[styles.badge, styles.badgeDisabled]}>Désactivé</Text>
            )}
            {u.id === user.id && <Text style={styles.you}>(vous)</Text>}
          </View>
          <Text style={styles.subtle} numberOfLines={1}>
            @{u.username} · {u.email}
          </Text>
        </View>
        <View style={styles.actions}>
          {actions.length === 0 && <Text style={styles.subtle}>—</Text>}
          {actions.map((a) => (
            <Pressable
              key={a.key}
              disabled={busyId === u.id}
              style={[styles.actionBtn, a.danger && styles.actionBtnDanger]}
              onPress={() => requestAction(u, a.key)}
            >
              <Text style={[styles.actionText, a.danger && styles.actionTextDanger]}>
                {a.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.search}
        placeholder="Rechercher (nom, username, email)"
        autoCapitalize="none"
        autoCorrect={false}
        value={query}
        onChangeText={setQuery}
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.aubergine} />
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={users.length === 0 && styles.empty}
          ListEmptyComponent={<Text style={styles.subtle}>Aucun résultat.</Text>}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoad}>
                <ActivityIndicator color={colors.aubergine} />
              </View>
            ) : users.length > 0 ? (
              <Text style={styles.footerText}>
                {users.length} / {total} affiché{total > 1 ? "s" : ""}
                {hasMore ? " — défilez pour charger plus" : ""}
              </Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  search: {
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    padding: 12,
    color: colors.text,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    backgroundColor: colors.white,
  },
  nameRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  name: { fontWeight: "600", color: colors.text, flexShrink: 1 },
  nameDisabled: { color: colors.textMuted, textDecorationLine: "line-through" },
  subtle: { color: colors.textMuted, fontSize: 12 },
  you: { color: colors.textMuted, fontSize: 11 },
  badge: {
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  badgeOwner: { color: "#92400E", backgroundColor: "#FEF3C7" },
  badgeAdmin: { color: "#1E40AF", backgroundColor: "#DBEAFE" },
  badgeDisabled: { color: "#374151", backgroundColor: "#E5E7EB" },
  actions: { flexDirection: "column", gap: 4, alignItems: "flex-end" },
  actionBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  actionBtnDanger: { borderColor: "#FCA5A5" },
  actionText: { fontSize: 11, color: colors.text },
  actionTextDanger: { color: "#B91C1C" },
  sep: { height: 1, backgroundColor: colors.border },
  empty: { padding: 20, alignItems: "center" },
  footerLoad: { padding: 12, alignItems: "center" },
  footerText: { color: colors.textMuted, fontSize: 12, padding: 12, textAlign: "center" },
});
