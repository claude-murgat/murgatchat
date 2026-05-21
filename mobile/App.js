import { useEffect, useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";

import LoginScreen from "./src/screens/LoginScreen";
import ChannelListScreen from "./src/screens/ChannelListScreen";
import ChannelScreen from "./src/screens/ChannelScreen";
import { api, getToken, setToken } from "./src/api";
import { closeSocket } from "./src/socket";
import { colors } from "./src/theme";

const Stack = createNativeStackNavigator();

export default function App() {
  const [user, setUser] = useState(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) {
        setBootstrapped(true);
        return;
      }
      try {
        const res = await api.me();
        setUser(res.user);
      } catch {
        await setToken(null);
      } finally {
        setBootstrapped(true);
      }
    })();
  }, []);

  async function handleLogout() {
    await setToken(null);
    closeSocket();
    setUser(null);
  }

  if (!bootstrapped) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.aubergine,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
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
          }}
        >
          <Stack.Screen
            name="Channels"
            options={{ title: "Conversations" }}
            initialParams={{ user, onLogout: handleLogout }}
          >
            {(props) => (
              <ChannelListScreen
                {...props}
                route={{
                  ...props.route,
                  params: { user, onLogout: handleLogout },
                }}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="Channel" component={ChannelScreen} />
        </Stack.Navigator>
      ) : (
        <LoginScreen onLoggedIn={setUser} />
      )}
    </NavigationContainer>
  );
}
