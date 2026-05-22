import { View } from "react-native";

export default function PresenceDot({ online, size = 10 }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: online ? "#2BAC76" : "#94A3B8",
      }}
    />
  );
}
