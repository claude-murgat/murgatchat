import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View, Text, StyleSheet } from "react-native";

import { ChatProvider, useChat } from "./src/ChatContext";
import LoginScreen from "./src/screens/LoginScreen";
import ChannelListScreen from "./src/screens/ChannelListScreen";
import ChannelScreen from "./src/screens/ChannelScreen";
import MembersScreen from "./src/screens/MembersScreen";
import AddMembersScreen from "./src/screens/AddMembersScreen";
import NewChannelScreen from "./src/screens/NewChannelScreen";
import NewDmScreen from "./src/screens/NewDmScreen";
import BrowseChannelsScreen from "./src/screens/BrowseChannelsScreen";
import DndScreen from "./src/screens/DndScreen";
import AdminPanelScreen from "./src/screens/AdminPanelScreen";
import SearchScreen from "./src/screens/SearchScreen";
import UpdateBanner from "./src/components/UpdateBanner";
import { colors } from "./src/theme";

const Stack = createNativeStackNavigator();

function Toast() {
  const { toast } = useChat();
  if (!toast) return null;
  return (
    <View style={styles.toast} pointerEvents="none">
      <Text style={styles.toastTitle}>{toast.title}</Text>
      <Text style={styles.toastBody} numberOfLines={1}>
        {toast.body}
      </Text>
    </View>
  );
}

function Root() {
  const { user, bootstrapped } = useChat();

  if (!bootstrapped) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      {user ? (
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.aubergine },
            headerTintColor: colors.white,
            headerTitleStyle: { color: colors.white },
          }}
        >
          <Stack.Screen name="Channels" component={ChannelListScreen} options={{ title: "Conversations" }} />
          <Stack.Screen name="Channel" component={ChannelScreen} />
          <Stack.Screen name="Members" component={MembersScreen} options={{ title: "Membres" }} />
          <Stack.Screen name="AddMembers" component={AddMembersScreen} options={{ title: "Ajouter des membres" }} />
          <Stack.Screen name="NewChannel" component={NewChannelScreen} options={{ title: "Créer une conversation" }} />
          <Stack.Screen name="NewDm" component={NewDmScreen} options={{ title: "Nouveau message" }} />
          <Stack.Screen name="Browse" component={BrowseChannelsScreen} options={{ title: "Parcourir les salons" }} />
          <Stack.Screen name="Dnd" component={DndScreen} options={{ title: "Ne pas déranger" }} />
          <Stack.Screen name="AdminPanel" component={AdminPanelScreen} options={{ title: "Administration" }} />
          <Stack.Screen name="Search" component={SearchScreen} options={{ title: "Rechercher" }} />
        </Stack.Navigator>
      ) : (
        <LoginScreen />
      )}
      <Toast />
      <UpdateBanner />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ChatProvider>
      <Root />
    </ChatProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.aubergine, alignItems: "center", justifyContent: "center" },
  toast: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: colors.aubergineDark,
    borderRadius: 10,
    padding: 12,
  },
  toastTitle: { color: colors.white, fontWeight: "700", fontSize: 14 },
  toastBody: { color: "#ddd", fontSize: 13, marginTop: 2 },
});
