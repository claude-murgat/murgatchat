import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { api } from "../api";
import { colors } from "../theme";

const PAGE_SIZE = 30;

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function ReportDetail({ report, busy, onResolve, onReopen, onDelete }) {
  const diag =
    report.diagnostics && typeof report.diagnostics === "object"
      ? report.diagnostics
      : null;

  async function copyAll() {
    const text =
      `Rapport ${report.id}\n` +
      `De: ${report.user ? "@" + report.user.username : "utilisateur supprimé"}\n` +
      `Date: ${fmtDate(report.createdAt)}\n\n` +
      `Message:\n${report.message}\n\n` +
      (diag
        ? `=== Diagnostic ===\n${Object.entries(diag)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}\n\n`
        : "") +
      (report.logs ? `=== Logs ===\n${report.logs}` : "");
    try {
      await Clipboard.setStringAsync(text);
      Alert.alert("Copié", "Rapport copié dans le presse-papier.");
    } catch {
      /* ignore */
    }
  }

  return (
    <View style={styles.detail}>
      <Text style={styles.detailMessage}>{report.message}</Text>

      {diag && (
        <View style={styles.detailBlock}>
          <Text style={styles.detailLabel}>Diagnostic</Text>
          {Object.entries(diag).map(([k, v]) => (
            <Text key={k} style={styles.diagLine}>
              <Text style={styles.diagKey}>{k}: </Text>
              {String(v)}
            </Text>
          ))}
        </View>
      )}

      {report.logs ? (
        <View style={styles.detailBlock}>
          <Text style={styles.detailLabel}>Logs</Text>
          <Text style={styles.logsText} numberOfLines={20}>
            {report.logs}
          </Text>
        </View>
      ) : null}

      <View style={styles.detailActions}>
        <Pressable style={styles.smallBtn} onPress={copyAll}>
          <Text style={styles.smallBtnText}>Copier</Text>
        </Pressable>
        {report.status === "open" ? (
          <Pressable
            style={styles.smallBtn}
            disabled={busy}
            onPress={() => onResolve(report)}
          >
            <Text style={styles.smallBtnText}>Marquer résolu</Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.smallBtn}
            disabled={busy}
            onPress={() => onReopen(report)}
          >
            <Text style={styles.smallBtnText}>Rouvrir</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.smallBtn, styles.smallBtnDanger]}
          disabled={busy}
          onPress={() => onDelete(report)}
        >
          <Text style={[styles.smallBtnText, styles.smallBtnTextDanger]}>Supprimer</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function BugReportsScreen() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState("open"); // "open" | "" (all)
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const fetchSeq = useRef(0);

  async function fetchPage({ p, status, append }) {
    const seq = ++fetchSeq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const res = await api.listBugReports({ page: p, pageSize: PAGE_SIZE, status });
      if (seq !== fetchSeq.current) return;
      setReports((prev) => (append ? [...prev, ...res.reports] : res.reports));
      setHasMore(res.hasMore);
      setTotal(res.total);
      setOpenCount(res.openCount);
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

  useEffect(() => {
    fetchPage({ p: 1, status: statusFilter, append: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function loadMore() {
    if (!hasMore || loadingMore || loading) return;
    fetchPage({ p: page + 1, status: statusFilter, append: true });
  }

  async function changeStatus(report, status) {
    setBusyId(report.id);
    try {
      const res = await api.updateBugReport(report.id, status);
      setReports((prev) => {
        if (statusFilter === "open" && status === "closed") {
          return prev.filter((x) => x.id !== report.id);
        }
        return prev.map((x) => (x.id === report.id ? res.report : x));
      });
      setOpenCount((c) => (status === "closed" ? Math.max(0, c - 1) : c + 1));
    } catch (e) {
      Alert.alert("Erreur", e.data?.error || e.message || "Action refusée");
    } finally {
      setBusyId(null);
    }
  }

  function confirmDelete(report) {
    Alert.alert(
      "Supprimer le rapport",
      "Supprimer définitivement ce rapport ? Cette action est irréversible.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Supprimer",
          style: "destructive",
          onPress: async () => {
            setBusyId(report.id);
            try {
              await api.deleteBugReport(report.id);
              setReports((prev) => prev.filter((x) => x.id !== report.id));
              setTotal((t) => Math.max(0, t - 1));
              if (report.status === "open") setOpenCount((c) => Math.max(0, c - 1));
            } catch (e) {
              Alert.alert("Erreur", e.data?.error || e.message || "Suppression refusée");
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  }

  function renderItem({ item: r }) {
    const expanded = expandedId === r.id;
    return (
      <Pressable
        style={styles.row}
        onPress={() => setExpandedId(expanded ? null : r.id)}
      >
        <View style={styles.metaRow}>
          <Text
            style={[styles.badge, r.status === "closed" ? styles.badgeClosed : styles.badgeOpen]}
          >
            {r.status === "closed" ? "Résolu" : "Ouvert"}
          </Text>
          {r.platform ? <Text style={styles.platform}>{r.platform}</Text> : null}
          {r.appVersion ? <Text style={styles.subtle}>v{r.appVersion}</Text> : null}
          <Text style={styles.date}>{fmtDate(r.createdAt)}</Text>
        </View>
        <Text
          style={[styles.message, r.status === "closed" && styles.messageClosed]}
          numberOfLines={expanded ? undefined : 2}
        >
          {r.message}
        </Text>
        <Text style={styles.subtle} numberOfLines={1}>
          {r.user ? `@${r.user.username}` : "utilisateur supprimé"}
        </Text>

        {expanded && (
          <ReportDetail
            report={r}
            busy={busyId === r.id}
            onResolve={(rep) => changeStatus(rep, "closed")}
            onReopen={(rep) => changeStatus(rep, "open")}
            onDelete={confirmDelete}
          />
        )}
      </Pressable>
    );
  }

  const FilterButton = ({ value, label }) => (
    <Pressable
      onPress={() => setStatusFilter(value)}
      style={[styles.filterBtn, statusFilter === value && styles.filterBtnOn]}
    >
      <Text
        style={[styles.filterText, statusFilter === value && styles.filterTextOn]}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        <FilterButton value="open" label={`Ouverts (${openCount})`} />
        <FilterButton value="" label={`Tous (${total})`} />
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.aubergine} />
        </View>
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={reports.length === 0 && styles.empty}
          ListEmptyComponent={<Text style={styles.subtle}>Aucun rapport.</Text>}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoad}>
                <ActivityIndicator color={colors.aubergine} />
              </View>
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
  filterRow: {
    flexDirection: "row",
    gap: 8,
    padding: 10,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterBtnOn: { borderColor: colors.aubergine, backgroundColor: "#F3E8F1" },
  filterText: { fontSize: 13, color: colors.textMuted },
  filterTextOn: { color: colors.aubergine, fontWeight: "700" },
  row: { paddingHorizontal: 14, paddingVertical: 12, backgroundColor: colors.white },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  badge: {
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  badgeOpen: { color: "#92400E", backgroundColor: "#FEF3C7" },
  badgeClosed: { color: "#374151", backgroundColor: "#E5E7EB" },
  platform: {
    fontSize: 10,
    fontWeight: "600",
    color: "#1E40AF",
    backgroundColor: "#EFF6FF",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  date: { fontSize: 11, color: colors.textMuted },
  message: { fontSize: 14, color: colors.text, marginTop: 6 },
  messageClosed: { color: colors.textMuted },
  subtle: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  detail: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  detailMessage: {
    fontSize: 14,
    color: colors.text,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 8,
  },
  detailBlock: { marginTop: 10 },
  detailLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    color: colors.textMuted,
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  diagLine: { fontSize: 12, color: "#334155" },
  diagKey: { color: colors.textMuted },
  logsText: { fontSize: 11, color: "#334155", fontFamily: "monospace" },
  detailActions: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  smallBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  smallBtnText: { fontSize: 12, color: colors.text },
  smallBtnDanger: { borderColor: "#FCA5A5" },
  smallBtnTextDanger: { color: "#B91C1C" },
  sep: { height: 1, backgroundColor: colors.border },
  empty: { padding: 20, alignItems: "center" },
  footerLoad: { padding: 12, alignItems: "center" },
});
