import { useState, useEffect } from "react";
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
import { api, setToken, getApiBaseUrl, setApiBaseUrl, pingServer } from "../api";
import { useChat } from "../ChatContext";
import { colors } from "../theme";

export default function LoginScreen() {
  const { login } = useChat();
  const [mode, setMode] = useState("login");
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => getApiBaseUrl());
  const [serverStatus, setServerStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [invite, setInvite] = useState(null); // {email, valid, expired, accepted} | {error} | null
  const [inviteChecking, setInviteChecking] = useState(false);

  // Validate the invitation code (debounced) when registering, to prefill email.
  useEffect(() => {
    if (mode !== "register") return;
    const code = inviteCode.trim();
    if (!code) {
      setInvite(null);
      return;
    }
    setInviteChecking(true);
    const t = setTimeout(async () => {
      try {
        await setApiBaseUrl(serverUrl);
        setInvite(await api.getInvitation(code));
      } catch {
        setInvite({ error: true });
      } finally {
        setInviteChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [inviteCode, mode, serverUrl]);

  const inviteOk = !!invite?.valid;
  const inviteHint = !inviteCode.trim()
    ? null
    : inviteChecking
    ? "Vérification…"
    : invite?.error
    ? "Impossible de vérifier — vérifiez l'adresse du serveur."
    : invite?.valid
    ? `Invitation valide pour ${invite.email}`
    : invite?.accepted
    ? "Invitation déjà utilisée."
    : invite?.expired
    ? "Invitation expirée."
    : "Invitation introuvable.";
  const registerBlocked = mode === "register" && !!inviteCode.trim() && !inviteOk;

  async function testServer() {
    setTesting(true);
    setServerStatus(null);
    try {
      await pingServer(serverUrl);
      setServerStatus({ ok: true, msg: "Serveur joignable ✓" });
    } catch (e) {
      setServerStatus({ ok: false, msg: `Injoignable : ${e.message || "erreur"}` });
    } finally {
      setTesting(false);
    }
  }

  async function submit() {
    const base = await setApiBaseUrl(serverUrl);
    if (!base) {
      Alert.alert(
        "Serveur requis",
        "Indiquez l'adresse du serveur (ex. https://chat.exemple.fr)."
      );
      return;
    }
    setServerUrl(base);
    setBusy(true);
    try {
      let res;
      if (mode === "login") {
        res = await api.login({ emailOrUsername, password });
      } else {
        const code = inviteCode.trim();
        if (code && !inviteOk) {
          Alert.alert("Erreur", "Invitation invalide ou expirée.");
          setBusy(false);
          return;
        }
        // With a valid code: email comes from the invitation. Without a code:
        // bootstrap (first account) — the server allows it only if the DB is empty.
        const body = {
          email: inviteOk ? invite.email : email,
          username,
          displayName,
          password,
        };
        if (inviteOk) body.token = code;
        res = await api.register(body);
      }
      await setToken(res.token);
      login(res.user);
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
          {mode === "login" ? "Bon retour parmi nous." : "Inscription sur invitation."}
        </Text>

        <Text style={styles.label}>Adresse du serveur</Text>
        <View style={styles.serverRow}>
          <TextInput
            style={[styles.input, styles.serverInput]}
            placeholder="https://chat.exemple.fr"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={serverUrl}
            onChangeText={(t) => {
              setServerUrl(t);
              setServerStatus(null);
            }}
          />
          <TouchableOpacity
            style={[
              styles.testBtn,
              (testing || !serverUrl.trim()) && styles.testBtnDisabled,
            ]}
            disabled={testing || !serverUrl.trim()}
            onPress={testServer}
          >
            <Text style={styles.testBtnText}>{testing ? "…" : "Tester"}</Text>
          </TouchableOpacity>
        </View>
        {serverStatus && (
          <Text
            style={[
              styles.serverStatus,
              { color: serverStatus.ok ? "#16A34A" : "#DC2626" },
            ]}
          >
            {serverStatus.msg}
          </Text>
        )}

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
              placeholder="Code d'invitation"
              autoCapitalize="none"
              autoCorrect={false}
              value={inviteCode}
              onChangeText={setInviteCode}
            />
            {inviteHint && (
              <Text
                style={[
                  styles.serverStatus,
                  { color: inviteOk ? "#16A34A" : colors.textMuted },
                ]}
              >
                {inviteHint}
              </Text>
            )}
            <TextInput
              style={[styles.input, inviteOk && styles.inputReadOnly]}
              placeholder="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              value={inviteOk ? invite.email : email}
              onChangeText={setEmail}
              editable={!inviteOk}
            />
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
          </>
        )}
        <TextInput
          style={styles.input}
          placeholder="Mot de passe"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <TouchableOpacity
          style={[styles.btn, registerBlocked && styles.btnDisabled]}
          disabled={busy || registerBlocked}
          onPress={submit}
        >
          <Text style={styles.btnText}>
            {busy ? "..." : mode === "login" ? "Se connecter" : "S'inscrire"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            setMode(mode === "login" ? "register" : "login");
            setInvite(null);
          }}
        >
          <Text style={styles.link}>
            {mode === "login"
              ? "J'ai une invitation — s'inscrire"
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
  inputReadOnly: {
    backgroundColor: colors.bg,
    color: colors.textMuted,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
    marginBottom: 4,
  },
  serverRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 4,
  },
  serverInput: {
    flex: 1,
    marginBottom: 0,
  },
  testBtn: {
    borderWidth: 1,
    borderColor: colors.aubergine,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: "center",
  },
  testBtnDisabled: {
    opacity: 0.5,
  },
  testBtnText: {
    color: colors.aubergine,
    fontWeight: "600",
  },
  serverStatus: {
    fontSize: 12,
    marginBottom: 10,
  },
  btn: {
    backgroundColor: colors.aubergine,
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 4,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: colors.white, fontWeight: "600" },
  link: {
    color: colors.aubergine,
    textAlign: "center",
    marginTop: 12,
  },
});
