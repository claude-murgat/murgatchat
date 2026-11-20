import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors } from "../theme";

// Barre d'onglets en bas de l'accueil. `tabs` : [{ key, label, icon, badge }] ;
// `icon` est un nom Ionicons dont la variante « -outline » sert à l'onglet inactif,
// `badge` le nombre de conversations non lues de l'onglet.
export default function HomeTabBar({ tabs, active, onChange }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 6) }]} accessibilityRole="tablist">
      {tabs.map((t) => {
        const on = t.key === active;
        const badge = t.badge > 99 ? "99+" : String(t.badge || "");
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            style={styles.tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={
              t.badge ? `${t.label}, ${t.badge} non lu${t.badge > 1 ? "s" : ""}` : t.label
            }
          >
            <View style={[styles.pill, on && styles.pillOn]}>
              <Ionicons
                name={on ? t.icon : `${t.icon}-outline`}
                size={22}
                color={on ? colors.aubergine : colors.textMuted}
              />
              {!!t.badge && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: colors.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 6,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: -2 },
  },
  tab: { flex: 1, alignItems: "center", gap: 2 },
  pill: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  pillOn: { backgroundColor: colors.aubergineTint },
  badge: {
    position: "absolute",
    top: -2,
    right: 6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.red,
    borderWidth: 2,
    borderColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: "700", lineHeight: 12 },
  label: { fontSize: 12, color: colors.textMuted },
  labelOn: { color: colors.aubergine, fontWeight: "700" },
});
