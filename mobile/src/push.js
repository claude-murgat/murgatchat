import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { api } from "./api";

// When the app is in the FOREGROUND, don't pop a system banner — the app's own UI
// already shows the message. Background / locked notifications are shown by the OS
// regardless of this handler, which is exactly the "notify only when away" behavior.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Ask permission, get the Expo push token, and register it with the server.
// Returns the token, or undefined if unavailable (no projectId / FCM creds yet,
// permission denied, or running on web) — the app keeps working either way.
export async function registerForPush() {
  try {
    if (Platform.OS === "web") return;

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Messages",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ||
      Constants.easConfig?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    await api.registerPushToken(token, Platform.OS);
    return token;
  } catch (e) {
    // Expected until an EAS projectId + FCM credentials are configured.
    console.log("[push] registration skipped:", e?.message || String(e));
  }
}
