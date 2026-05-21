import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { api, setToken } from "../api";
import { colors } from "../theme";

export default function LoginScreen({ onLoggedIn }) {
  const [mode, setMode] = useState("login");
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await api.login({ emailOrUsername, password })
          : await api.register({ email, username, displayName, password });
      await setToken(res.token);
      onLoggedIn(res.user);
    } catch (err) {
      Alert.alert("Erreur", err.message || "Échec");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Chat</Text>
        <Text style={styles.subtitle}>
          {mode === "login" ? "Bon retour parmi nous." : "Créez votre compte."}
        </Text>

        {mode === "login" ? (
          <TextInput
            style={styles.input}
            placeholder="email ou nom d'utilisateur"
            autoCapitalize="none"
            value={emailOrUsername}
            onChangeText={setEmailOrUsername}
          />
        ) : (
          <>
            <TextInput
              style={styles.input}
              placeholder="Nom affiché"
              value={displayName}
              onChangeText={setDisplayName}
            />
            <TextInput
              style={styles.input}
              placeholder="Nom d'utilisateur"
              autoCapitalize="none"
              value={username}
              onChangeText={setUsername}
            />
            <TextInput
              style={styles.input}
              placeholder="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
          </>
        )}
        <TextInput
          style={styles.input}
          placeholder="Mot de passe"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <TouchableOpacity style={styles.btn} disabled={busy} onPress={submit}>
          <Text style={styles.btnText}>
            {busy ? "..." : mode === "login" ? "Se connecter" : "S'inscrire"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setMode(mode === "login" ? "register" : "login")}
        >
          <Text style={styles.link}>
            {mode === "login"
              ? "Pas encore de compte ? S'inscrire"
              : "Déjà un compte ? Se connecter"}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.aubergine,
    justifyContent: "center",
    padding: 20,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: colors.aubergine,
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textMuted,
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    color: colors.text,
  },
  btn: {
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 4,
  },
  btnText: { color: colors.white, fontWeight: "600" },
  link: {
    color: colors.aubergine,
    textAlign: "center",
    marginTop: 12,
  },
});
