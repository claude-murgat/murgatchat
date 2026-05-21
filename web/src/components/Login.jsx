import { useState } from "react";
import { api, setToken } from "../api.js";

export default function Login({ onLoggedIn }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    emailOrUsername: "",
    email: "",
    username: "",
    displayName: "",
    password: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "login"
          ? await api.login({
              emailOrUsername: form.emailOrUsername,
              password: form.password,
            })
          : await api.register({
              email: form.email,
              username: form.username,
              displayName: form.displayName,
              password: form.password,
            });
      setToken(res.token);
      onLoggedIn(res.user);
    } catch (err) {
      setError(err.message || "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-aubergine-900 via-aubergine-800 to-aubergine-700 p-4">
      <div className="w-full max-w-md bg-white text-slate-900 rounded-xl shadow-2xl overflow-hidden">
        <div className="bg-aubergine-700 text-white p-6">
          <div className="flex items-center gap-2 text-2xl font-bold">
            <span className="inline-block w-9 h-9 rounded-lg bg-white text-aubergine-700 grid place-items-center">#</span>
            Chat
          </div>
          <p className="opacity-80 mt-1 text-sm">
            {mode === "login" ? "Bon retour parmi nous." : "Créez votre compte."}
          </p>
        </div>
        <form onSubmit={submit} className="p-6 space-y-3">
          {mode === "login" ? (
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="email ou nom d'utilisateur"
              value={form.emailOrUsername}
              onChange={(e) => update("emailOrUsername", e.target.value)}
              required
            />
          ) : (
            <>
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
              <input
                className="w-full border rounded-md px-3 py-2"
                placeholder="Email"
                type="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                required
              />
            </>
          )}
          <input
            className="w-full border rounded-md px-3 py-2"
            placeholder="Mot de passe"
            type="password"
            value={form.password}
            onChange={(e) => update("password", e.target.value)}
            required
          />
          {error && <div className="text-sm text-red-600">{error}</div>}
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-aubergine-700 hover:bg-aubergine-800 text-white font-medium rounded-md py-2 disabled:opacity-60"
          >
            {busy ? "..." : mode === "login" ? "Se connecter" : "S'inscrire"}
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
            className="w-full text-aubergine-700 text-sm hover:underline"
          >
            {mode === "login"
              ? "Pas encore de compte ? S'inscrire"
              : "Déjà un compte ? Se connecter"}
          </button>
        </form>
      </div>
    </div>
  );
}
