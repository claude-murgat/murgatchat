import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

export const API_URL =
  Constants.expoConfig?.extra?.API_URL ||
  process.env.EXPO_PUBLIC_API_URL ||
  "http://10.0.2.2:4000";

const TOKEN_KEY = "chat_token";

export async function getToken() {
  return AsyncStorage.getItem(TOKEN_KEY);
}
export async function setToken(t) {
  if (t) await AsyncStorage.setItem(TOKEN_KEY, t);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

export const api = {
  register: (body) => request("/auth/register", { method: "POST", body, auth: false }),
  login: (body) => request("/auth/login", { method: "POST", body, auth: false }),
  me: () => request("/auth/me"),
  setDnd: (minutes) => request("/auth/dnd", { method: "POST", body: { minutes } }),
  listUsers: (q) => request(`/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  listChannels: () => request("/channels"),
  createChannel: (body) => request("/channels", { method: "POST", body }),
  openDm: (userId) => request("/channels/dm", { method: "POST", body: { userId } }),
  messages: (channelId) => request(`/channels/${channelId}/messages`),
  scheduled: (channelId) => request(`/channels/${channelId}/scheduled`),
  deleteScheduled: (id) => request(`/channels/scheduled/${id}`, { method: "DELETE" }),
  updateScheduled: (id, body) =>
    request(`/channels/scheduled/${id}`, { method: "PATCH", body }),
};
