import { useState, useLayoutEffect, useMemo, useCallback } from "react";
import {
  View,
  Text,
  SectionList,
  Pressable,
  Modal,
  Image,
  BackHandler,
  StyleSheet,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useChat } from "../ChatContext";
import PresenceDot from "../components/PresenceDot";
import ConversationRow from "../components/ConversationRow";
import HomeTabBar from "../components/HomeTabBar";
import InviteModal from "../components/InviteModal";
import ProfileModal from "../components/ProfileModal";
import BugReportModal from "../components/BugReportModal";
import { homeLists } from "../conversations";
import { colors } from "../theme";

function dndActive(user) {
  return user?.dndUntil && new Date(user.dndUntil) > new Date();
}

// L'accueil, en trois onglets (comme les messageries mobiles) : on ouvre l'appli sur
// les conversations récentes, non lues d'abord, plutôt que sur la liste complète des
// salons puis des messages directs. Les deux autres onglets gardent ces listes, avec
// leurs actions (créer, parcourir, nouveau message).
const TABS = [
  { key: "recent", label: "Récents", title: "Récents", icon: "time" },
  { key: "salons", label: "Salons", title: "Salons", icon: "people" },
  { key: "dms", label: "Directs", title: "Messages directs", icon: "chatbubbles" },
];

const EMPTY = {
  recent: {
    title: "Aucune conversation récente",
    hint: "Vos salons et vos messages directs sont dans les onglets ci-dessous.",
  },
  salons: { title: "Aucun salon", hint: "Créez un salon, ou rejoignez un salon public." },
  dms: { title: "Aucun message direct", hint: "Écrivez à un collègue avec « Nouveau message »." },
};

export default function ChannelListScreen({ navigation }) {
  const { user, setUser, channels, onlineUserIds, typingByChannel, markRead, logout } = useChat();
  const [tab, setTab] = useState("recent");
  const [menu, setMenu] = useState(false);
  const [invite, setInvite] = useState(false);
  const [profile, setProfile] = useState(false);
  const [bugReport, setBugReport] = useState(false);

  const lists = useMemo(() => homeLists(channels, user), [channels, user]);
  const current = TABS.find((t) => t.key === tab);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: current.title,
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable
            onPress={() => navigation.navigate("Search")}
            style={{ paddingHorizontal: 10 }}
            hitSlop={6}
            accessibilityLabel="Rechercher"
          >
            <Ionicons name="search" size={21} color={colors.white} />
          </Pressable>
          <Pressable
            onPress={() => setMenu(true)}
            style={{ paddingLeft: 8, paddingRight: 4 }}
            hitSlop={6}
            accessibilityLabel="Menu"
          >
            <Ionicons name="ellipsis-vertical" size={21} color={colors.white} />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, current.title]);

  // Bouton retour d'Android sur l'onglet Salons ou Directs : retour à Récents, comme
  // dans les applis à onglets ; depuis Récents, il quitte l'appli comme avant.
  useFocusEffect(
    useCallback(() => {
      if (tab === "recent") return undefined;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        setTab("recent");
        return true;
      });
      return () => sub.remove();
    }, [tab])
  );

  const open = useCallback(
    (c) => {
      markRead(c.id);
      navigation.navigate("Channel", { channelId: c.id });
    },
    [markRead, navigation]
  );

  const sections = useMemo(() => {
    let list;
    if (tab === "recent") {
      const titled = lists.recentUnread.length > 0;
      list = [
        { key: "unread", title: "Non lus", data: lists.recentUnread },
        { key: "read", title: titled ? "Récents" : null, data: lists.recentRead },
      ];
    } else if (tab === "salons") {
      list = [
        { key: "salons", title: lists.experts.length ? "Salons" : null, data: lists.salons },
        { key: "experts", title: "Experts Claude", data: lists.experts },
      ];
    } else {
      list = [
        { key: "dms", title: null, data: lists.selfDm ? [lists.selfDm, ...lists.dms] : lists.dms },
      ];
    }
    // Sections vides retirées : sans section du tout, SectionList affiche l'état vide.
    return list.filter((s) => s.data.length > 0);
  }, [tab, lists]);

  const renderItem = useCallback(
    ({ item: c }) => {
      const other =
        c.isDirect && c.members.length === 2 ? c.members.find((m) => m.id !== user?.id) : null;
      return (
        <ConversationRow
          channel={c}
          user={user}
          online={!!other && !!onlineUserIds?.has(other.id)}
          typingIds={typingByChannel?.[c.id]}
          onPress={open}
        />
      );
    },
    [user, onlineUserIds, typingByChannel, open]
  );

  const actions =
    tab === "salons" ? (
      <View style={styles.actions}>
        <ActionChip icon="add" label="Créer un salon" onPress={() => navigation.navigate("NewChannel")} />
        <ActionChip icon="search" label="Parcourir" onPress={() => navigation.navigate("Browse")} />
      </View>
    ) : tab === "dms" ? (
      <View style={styles.actions}>
        <ActionChip icon="create-outline" label="Nouveau message" onPress={() => navigation.navigate("NewDm")} />
      </View>
    ) : null;

  return (
    <View style={styles.container}>
      <View style={styles.workspace}>
        {/* Logo de Murgat Chat, en blanc sur l'aubergine (comme la barre latérale du web). */}
        <Image source={require("../../assets/logo-blanc.png")} style={styles.wsLogo} />
        <View style={{ flex: 1 }}>
          <Text style={styles.wsName}>Murgat Chat</Text>
          <View style={styles.wsUserRow}>
            <PresenceDot online size={8} />
            <Text style={styles.wsUser}>{user?.displayName}</Text>
          </View>
          {dndActive(user) && (
            <Text style={styles.dndLine}>
              Ne pas déranger · jusqu'à{" "}
              {new Date(user.dndUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
          )}
        </View>
      </View>

      <SectionList
        key={tab}
        style={styles.list}
        sections={sections}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) =>
          section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null
        }
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={actions}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{EMPTY[tab].title}</Text>
            <Text style={styles.emptyHint}>{EMPTY[tab].hint}</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 12 }}
      />

      <HomeTabBar
        tabs={TABS.map((t) => ({ ...t, badge: lists.counts[t.key] }))}
        active={tab}
        onChange={setTab}
      />

      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenu(false)}>
          <View style={styles.menu}>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                setProfile(true);
              }}
            >
              <Text style={styles.menuText}>Mon profil</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                navigation.navigate("Dnd");
              }}
            >
              <Text style={styles.menuText}>
                {dndActive(user) ? "Ne pas déranger (actif)" : "Ne pas déranger"}
              </Text>
            </Pressable>
            {user?.isAdmin && (
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setMenu(false);
                  setInvite(true);
                }}
              >
                <Text style={styles.menuText}>Inviter un utilisateur</Text>
              </Pressable>
            )}
            {user?.isAdmin && (
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setMenu(false);
                  navigation.navigate("AdminPanel");
                }}
              >
                <Text style={styles.menuText}>Administration</Text>
              </Pressable>
            )}
            {user?.isAdmin && (
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setMenu(false);
                  navigation.navigate("BugReports");
                }}
              >
                <Text style={styles.menuText}>Rapports de bug</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                setBugReport(true);
              }}
            >
              <Text style={styles.menuText}>🐞 Signaler un bug</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                logout();
              }}
            >
              <Text style={[styles.menuText, { color: colors.red }]}>Se déconnecter</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <InviteModal visible={invite} onClose={() => setInvite(false)} />
      <ProfileModal
        visible={profile}
        user={user}
        onClose={() => setProfile(false)}
        onUpdated={(u) => setUser(u)}
      />
      <BugReportModal visible={bugReport} onClose={() => setBugReport(false)} />
    </View>
  );
}

function ActionChip({ icon, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      accessibilityRole="button"
    >
      <Ionicons name={icon} size={17} color={colors.aubergine} />
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  workspace: {
    backgroundColor: colors.aubergine,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  wsLogo: { width: 36, height: 36 },
  wsName: { color: colors.white, fontWeight: "700", fontSize: 16 },
  wsUserRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  wsUser: { color: colors.aubergineMuted },
  dndLine: { color: "#FFC857", marginTop: 2, fontSize: 12 },
  list: { flex: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.aubergineMuted,
    backgroundColor: colors.white,
  },
  chipPressed: { backgroundColor: colors.aubergineTint },
  chipText: { color: colors.aubergine, fontWeight: "600", fontSize: 14 },
  sectionTitle: {
    textTransform: "uppercase",
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  empty: { paddingHorizontal: 32, paddingVertical: 48, alignItems: "center", gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "700", textAlign: "center" },
  emptyHint: { color: colors.textMuted, fontSize: 14, textAlign: "center" },
  menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.2)" },
  menu: { position: "absolute", top: 6, right: 8, backgroundColor: colors.white, borderRadius: 10, paddingVertical: 4, minWidth: 200, elevation: 6, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  menuItem: { paddingVertical: 12, paddingHorizontal: 16 },
  menuText: { fontSize: 15, color: colors.text },
});
