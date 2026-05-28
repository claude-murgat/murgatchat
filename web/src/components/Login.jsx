import { useState, useEffect } from "react";
import { api, setToken, getApiBaseUrl, setApiBaseUrl, pingServer } from "../api.js";

function tokenFromUrl(key) {
  try {
    return new URLSearchParams(window.location.search).get(key) || "";
  } catch {
    return "";
  }
}

function clearUrlQuery() {
  try {
    const u = new URL(window.location.href);
    if (u.search) {
      u.search = "";
      window.history.replaceState({}, "", u.toString());
    }
  } catch {
    /* ignore */
  }
}

export default function Login({ onLoggedIn }) {
  const urlInvite = tokenFromUrl("invite");
  const urlReset = tokenFromUrl("reset");
  const initialMode = urlReset ? "reset" : urlInvite ? "register" : "login";
  const [mode, setMode] = useState(initialMode);

  const [form, setForm] = useState({
    emailOrUsername: "",
    email: "",
    username: "",
    displayName: "",
    password: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [serverUrl, setServerUrl] = useState(() => getApiBaseUrl());
  const [serverStatus, setServerStatus] = useState(null);
  const [testing, setTesting] = useState(false);

  // Invite flow
  const [inviteCode, setInviteCode] = useState(urlInvite);
  const [invite, setInvite] = useState(null);
  const [inviteChecking, setInviteChecking] = useState(false);

  // Forgot flow
  const [forgotId, setForgotId] = useState("");

  // Reset flow
  const [resetCode, setResetCode] = useState(urlReset);
  const [resetInfo, setResetInfo] = useState(null); // {valid, expired, used, email}
  const [resetChecking, setResetChecking] = useState(false);

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function testServer() {
    setTesting(true);
    setServerStatus(null);
    try {
      await pingServer(serverUrl);
      setServerStatus({ ok: true, msg: "Serveur joignable ✓" });
    } catch (err) {
      setServerStatus({ ok: false, msg: `Injoignable : ${err.message || "erreur"}` });
    } finally {
      setTesting(false);
    }
  }

  // Validate the invitation code when registering, to prefill the email.
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
        setApiBaseUrl(serverUrl);
        setInvite(await api.getInvitation(code));
      } catch {
        setInvite({ error: true });
      } finally {
        setInviteChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [inviteCode, mode, serverUrl]);

  // Validate the reset code, to show the (masked) email.
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
        setApiBaseUrl(serverUrl);
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

  function switchMode(next) {
    setError(null);
    setInfo(null);
    setMode(next);
  }

  async function submit(e) {
    e.preventDefault();
    const base = setApiBaseUrl(serverUrl);
    if (!base) {
      setError("Indiquez l'adresse du serveur (ex. https://chat.exemple.fr).");
      return;
    }
    setServerUrl(base);
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "login") {
        const res = await api.login({
          emailOrUsername: form.emailOrUsername,
          password: form.password,
        });
        setToken(res.token);
        onLoggedIn(res.user);
      } else if (mode === "register") {
        const code = inviteCode.trim();
        if (code && !inviteOk) {
          setError("Invitation invalide ou expirée.");
          return;
        }
        const body = {
          email: inviteOk ? invite.email : form.email,
          username: form.username,
          displayName: form.displayName,
          password: form.password,
        };
        if (inviteOk) body.token = code;
        const res = await api.register(body);
        setToken(res.token);
        onLoggedIn(res.user);
      } else if (mode === "forgot") {
        await api.forgotPassword(forgotId.trim());
        setInfo(
          "Si un compte correspond, un e-mail vient d'être envoyé avec un lien et un code de réinitialisation."
        );
      } else if (mode === "reset") {
        const code = resetCode.trim();
        if (!code || !resetOk) {
          setError("Code de réinitialisation invalide ou expiré.");
          return;
        }
        if ((form.password || "").length < 6) {
          setError("Le mot de passe doit faire au moins 6 caractères.");
          return;
        }
        const res = await api.resetPassword(code, form.password);
        clearUrlQuery();
        setToken(res.token);
        onLoggedIn(res.user);
      }
    } catch (err) {
      setError(err.message || "Erreur");
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-aubergine-900 via-aubergine-800 to-aubergine-700 p-4">
      <div className="w-full max-w-md bg-white text-slate-900 rounded-xl shadow-2xl overflow-hidden">
        <div className="bg-aubergine-700 text-white p-6">
          <div className="flex items-center gap-2 text-2xl font-bold">
            <span className="inline-block w-9 h-9 rounded-lg bg-white text-aubergine-700 grid place-items-center">#</span>
            Chat
          </div>
          <p className="opacity-80 mt-1 text-sm">{subtitle}</p>
        </div>
        <form onSubmit={submit} className="p-6 space-y-3">
          <div className="space-y-1 pb-2 border-b border-slate-100">
            <label className="text-xs font-medium text-slate-600">Adresse du serveur</label>
            <div className="flex gap-2">
              <input
                className="flex-1 border rounded-md px-3 py-2 text-sm"
                placeholder="Adresse du serveur (ex. https://chat.exemple.fr)"
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setServerStatus(null);
                }}
              />
              <button
                type="button"
                onClick={testServer}
                disabled={testing || !serverUrl.trim()}
                className="px-3 py-2 text-sm rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
              >
                {testing ? "…" : "Tester"}
              </button>
            </div>
            {serverStatus && (
              <div className={`text-xs ${serverStatus.ok ? "text-green-600" : "text-red-600"}`}>
                {serverStatus.msg}
              </div>
            )}
          </div>

          {mode === "login" && (
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="email ou nom d'utilisateur"
              value={form.emailOrUsername}
              onChange={(e) => update("emailOrUsername", e.target.value)}
              required
            />
          )}

          {mode === "register" && (
            <>
              <div className="space-y-1">
                <input
                  className="w-full border rounded-md px-3 py-2"
                  placeholder="Code d'invitation"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                />
                {inviteHint && (
                  <div className={`text-xs ${inviteOk ? "text-green-600" : "text-slate-500"}`}>
                    {inviteHint}
                  </div>
                )}
              </div>
              <input
                className={`w-full border rounded-md px-3 py-2 ${
                  inviteOk ? "bg-slate-50 text-slate-500" : ""
                }`}
                placeholder="Email"
                type="email"
                value={inviteOk ? invite.email : form.email}
                onChange={(e) => update("email", e.target.value)}
                readOnly={inviteOk}
                required
              />
              <input
                className="w-full border rounded-md px-3 py-2"
                placeholder="Nom affiché"
                value={form.displayName}
                onChange={(e) => update("displayName", e.target.value)}
                required
              />
              <input
                className="w-full border rounded-md px-3 py-2"
                placeholder="Nom d'utilisateur"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                required
              />
            </>
          )}

          {mode === "forgot" && (
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="email ou nom d'utilisateur"
              value={forgotId}
              onChange={(e) => setForgotId(e.target.value)}
              required
            />
          )}

          {mode === "reset" && (
            <div className="space-y-1">
              <input
                className="w-full border rounded-md px-3 py-2"
                placeholder="Code de réinitialisation"
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                required
              />
              {resetHint && (
                <div className={`text-xs ${resetOk ? "text-green-600" : "text-slate-500"}`}>
                  {resetHint}
                </div>
              )}
            </div>
          )}

          {mode !== "forgot" && (
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder={mode === "reset" ? "Nouveau mot de passe" : "Mot de passe"}
              type="password"
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
              required
            />
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}
          {info && <div className="text-sm text-green-700">{info}</div>}

          <button
            type="submit"
            disabled={
              busy ||
              (mode === "register" && !!inviteCode.trim() && !inviteOk) ||
              (mode === "reset" && !!resetCode.trim() && !resetOk)
            }
            className="w-full bg-aubergine-700 hover:bg-aubergine-800 text-white font-medium rounded-md py-2 disabled:opacity-60"
          >
            {busy
              ? "..."
              : mode === "login"
              ? "Se connecter"
              : mode === "register"
              ? "S'inscrire"
              : mode === "forgot"
              ? "Envoyer le lien"
              : "Définir le mot de passe"}
          </button>

          <div className="flex flex-col gap-1">
            {mode === "login" && (
              <>
                <button
                  type="button"
                  onClick={() => switchMode("register")}
                  className="w-full text-aubergine-700 text-sm hover:underline"
                >
                  J'ai une invitation — s'inscrire
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("forgot")}
                  className="w-full text-aubergine-700 text-sm hover:underline"
                >
                  Mot de passe oublié ?
                </button>
              </>
            )}
            {mode === "register" && (
              <button
                type="button"
                onClick={() => switchMode("login")}
                className="w-full text-aubergine-700 text-sm hover:underline"
              >
                Déjà un compte ? Se connecter
              </button>
            )}
            {(mode === "forgot" || mode === "reset") && (
              <>
                {mode === "forgot" && (
                  <button
                    type="button"
                    onClick={() => switchMode("reset")}
                    className="w-full text-aubergine-700 text-sm hover:underline"
                  >
                    J'ai déjà un code — réinitialiser
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    clearUrlQuery();
                    switchMode("login");
                  }}
                  className="w-full text-aubergine-700 text-sm hover:underline"
                >
                  Retour à la connexion
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
