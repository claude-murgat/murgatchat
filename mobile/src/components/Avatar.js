import { View, Text } from "react-native";
import { colors } from "../theme";

export default function Avatar({ user, size = 36 }) {
  const initials = (user?.displayName || user?.username || "?")
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        backgroundColor: user?.avatarColor || "#4A154B",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: colors.white, fontWeight: "700", fontSize: size * 0.42 }}>
        {initials}
      </Text>
    </View>
  );
}
