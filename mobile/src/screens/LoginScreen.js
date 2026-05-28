import { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
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
  const [mode, setMode] = useState("login"); // login | register | forgot | reset
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => getApiBaseUrl());
  const [serverStatus, setServerStatus] = useState(null);
  const [testing, setTesting] = useState(false);

  // Invite flow
  const [inviteCode, setInviteCode] = useState("");
  const [invite, setInvite] = useState(null);
  const [inviteChecking, setInviteChecking] = useState(false);

  // Forgot/reset
  const [forgotId, setForgotId] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetInfo, setResetInfo] = useState(null);
  const [resetChecking, setResetChecking] = useState(false);
  const [info, setInfo] = useState(null);

  // Debounced invitation lookup.
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

  // Debounced reset-code lookup.
  useEffect(() => {
    if (mode !== "reset") return;
    const code = resetCode.trim();
    if (!code) {
      setResetInfo(null);
      return;
    }
    setResetChecking(true);
    const t = setTimeout(async () => {
      try {
        await setApiBaseUrl(serverUrl);
        setResetInfo(await api.getPasswordReset(code));
      } catch {
        setResetInfo({ valid: false, error: true });
      } finally {
        setResetChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [resetCode, mode, serverUrl]);

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

  const resetOk = !!resetInfo?.valid;
  const resetHint = !resetCode.trim()
    ? null
    : resetChecking
    ? "Vérification…"
    : resetInfo?.error
    ? "Impossible de vérifier — vérifiez l'adresse du serveur."
    : resetInfo?.valid
    ? `Code valide${resetInfo.email ? ` pour ${resetInfo.email}` : ""}`
    : resetInfo?.used
    ? "Code déjà utilisé."
    : resetInfo?.expired
    ? "Code expiré."
    : "Code introuvable.";

  const registerBlocked =
    mode === "register" && !!inviteCode.trim() && !inviteOk;
  const resetBlocked = mode === "reset" && !!resetCode.trim() && !resetOk;

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

  function switchMode(next) {
    setInfo(null);
    setMode(next);
  }

  async function submit() {
    const base = await setApiBaseUrl(serverUrl);
    if (!base) {
      Alert.alert("Serveur requis", "Indiquez l'adresse du serveur.");
      return;
    }
    setServerUrl(base);
    setBusy(true);
    setInfo(null);
    try {
      if (mode === "login") {
        const res = await api.login({ emailOrUsername, password });
        await setToken(res.token);
        login(res.user);
      } else if (mode === "register") {
        const code = inviteCode.trim();
        if (code && !inviteOk) {
          Alert.alert("Erreur", "Invitation invalide ou expirée.");
          return;
        }
        const body = {
          email: inviteOk ? invite.email : email,
          username,
          displayName,
          password,
        };
        if (inviteOk) body.token = code;
        const res = await api.register(body);
        await setToken(res.token);
        login(res.user);
      } else if (mode === "forgot") {
        await api.forgotPassword(forgotId.trim());
        setInfo(
          "Si un compte correspond, un e-mail vient d'être envoyé avec un lien et un code."
        );
      } else if (mode === "reset") {
        if (!resetOk) {
          Alert.alert("Erreur", "Code de réinitialisation invalide ou expiré.");
          return;
        }
        if ((password || "").length < 6) {
          Alert.alert("Erreur", "Le mot de passe doit faire au moins 6 caractères.");
          return;
        }
        const res = await api.resetPassword(resetCode.trim(), password);
        await setToken(res.token);
        login(res.user);
      }
    } catch (err) {
      Alert.alert("Erreur", err.message || "Échec");
    } finally {
      setBusy(false);
    }
  }

  const subtitle =
    mode === "login"
      ? "Bon retour parmi nous."
      : mode === "register"
      ? "Inscription sur invitation."
      : mode === "forgot"
      ? "Réinitialiser votre mot de passe."
      : "Choisissez un nouveau mot de passe.";

  const buttonLabel =
    mode === "login"
      ? "Se connecter"
      : mode === "register"
      ? "S'inscrire"
      : mode === "forgot"
      ? "Envoyer le lien"
      : "Définir le mot de passe";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
        <View style={styles.card}>
          <Text style={styles.title}>Chat</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>

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

          {mode === "login" && (
            <TextInput
              style={styles.input}
              placeholder="email ou nom d'utilisateur"
              autoCapitalize="none"
              value={emailOrUsername}
              onChangeText={setEmailOrUsername}
            />
          )}

          {mode === "register" && (
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

          {mode === "forgot" && (
            <TextInput
              style={styles.input}
              placeholder="email ou nom d'utilisateur"
              autoCapitalize="none"
              value={forgotId}
              onChangeText={setForgotId}
            />
          )}

          {mode === "reset" && (
            <>
              <TextInput
                style={styles.input}
                placeholder="Code de réinitialisation"
                autoCapitalize="none"
                autoCorrect={false}
                value={resetCode}
                onChangeText={setResetCode}
              />
              {resetHint && (
                <Text
                  style={[
                    styles.serverStatus,
                    { color: resetOk ? "#16A34A" : colors.textMuted },
                  ]}
                >
                  {resetHint}
                </Text>
              )}
            </>
          )}

          {mode !== "forgot" && (
            <TextInput
              style={styles.input}
              placeholder={mode === "reset" ? "Nouveau mot de passe" : "Mot de passe"}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
          )}

          {info && <Text style={styles.infoLine}>{info}</Text>}

          <TouchableOpacity
            style={[styles.btn, (registerBlocked || resetBlocked) && styles.btnDisabled]}
            disabled={busy || registerBlocked || resetBlocked}
            onPress={submit}
          >
            <Text style={styles.btnText}>{busy ? "..." : buttonLabel}</Text>
          </TouchableOpacity>

          {mode === "login" && (
            <>
              <TouchableOpacity onPress={() => switchMode("register")}>
                <Text style={styles.link}>J'ai une invitation — s'inscrire</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => switchMode("forgot")}>
                <Text style={styles.link}>Mot de passe oublié ?</Text>
              </TouchableOpacity>
            </>
          )}
          {mode === "register" && (
            <TouchableOpacity onPress={() => switchMode("login")}>
              <Text style={styles.link}>Déjà un compte ? Se connecter</Text>
            </TouchableOpacity>
          )}
          {(mode === "forgot" || mode === "reset") && (
            <>
              {mode === "forgot" && (
                <TouchableOpacity onPress={() => switchMode("reset")}>
                  <Text style={styles.link}>J'ai déjà un code — réinitialiser</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => switchMode("login")}>
                <Text style={styles.link}>Retour à la connexion</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.aubergine,
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
  infoLine: { fontSize: 13, color: "#16A34A", marginBottom: 8 },
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
