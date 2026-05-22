import http from "k6/http";
import ws from "k6/ws";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

// Load test for murgatchat. Two scenarios share the requested ramp profile so the
// peak is exactly 150 concurrent VUs:
//   - chatters (default 100) : persistent Socket.IO connections that send messages,
//     typing and read receipts (the realtime core).
//   - readers  (default 50)  : HTTP REST loops (me, channels, messages, public, react).
//
// Profile (per scenario, same timeline): ramp 1m -> hold 8m30s -> ramp-down 30s.
//
// Target the ISOLATED stack so the dev DB is never touched:
//   docker compose -f docker-compose.e2e.yml up -d --build      # api on :4001
//   k6 run load/k6/chat-load.js
// Override with -e BASE_URL=..., -e CHATTERS=.., -e READERS=.., or -e SMOKE=1.

const BASE = (__ENV.BASE_URL || "http://localhost:4001").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const SMOKE = !!__ENV.SMOKE;

const CHATTERS = SMOKE ? 4 : Number(__ENV.CHATTERS || 100);
const READERS = SMOKE ? 2 : Number(__ENV.READERS || 50);
const NUM_CHANNELS = SMOKE ? 2 : Number(__ENV.CHANNELS || 12);
const CHANNELS_PER_USER = SMOKE ? 1 : 3;

const rampStages = (target) =>
  SMOKE
    ? [
        { duration: "10s", target },
        { duration: "20s", target },
        { duration: "5s", target: 0 },
      ]
    : [
        { duration: "1m", target }, // build-up
        { duration: "8m30s", target }, // hold
        { duration: "30s", target: 0 }, // tear down
      ];

const wsConnectOk = new Rate("ws_connect_success");
const wsErrors = new Counter("ws_errors");
const messagesSent = new Counter("chat_messages_sent");
const eventsReceived = new Counter("chat_events_received");

export const options = {
  setupTimeout: "180s",
  scenarios: {
    chatters: {
      executor: "ramping-vus",
      exec: "chatter",
      startVUs: 0,
      stages: rampStages(CHATTERS),
      gracefulRampDown: "10s",
    },
    readers: {
      executor: "ramping-vus",
      exec: "reader",
      startVUs: 0,
      stages: rampStages(READERS),
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<3000"],
    checks: ["rate>0.90"],
    ws_connect_success: ["rate>0.95"],
  },
};

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const jsonHeaders = (token) => ({
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
});

function register(seed) {
  const tag = `ld_${seed}_${Date.now().toString(36)}${randInt(0, 9999)}`.slice(0, 30);
  const res = http.post(
    `${BASE}/auth/register`,
    JSON.stringify({
      email: `${tag}@load.local`,
      username: tag,
      displayName: tag,
      password: "test1234",
    }),
    jsonHeaders()
  );
  const body = res.json();
  if (res.status !== 200 || !body.token) {
    throw new Error(`register failed (${res.status}): ${res.body}`);
  }
  return { token: body.token, userId: body.user.id };
}

// Seed users + channels once, before the ramp. Returns the user pool for the VUs.
export function setup() {
  const total = CHATTERS + READERS;
  const admin = register("admin");

  const channels = [];
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const res = http.post(
      `${BASE}/channels`,
      JSON.stringify({ name: `load-${i}-${Date.now().toString(36)}` }),
      jsonHeaders(admin.token)
    );
    channels.push(res.json().channel.id);
  }

  const users = [];
  const membersByChannel = {};
  for (let i = 0; i < total; i++) {
    const u = register(`u${i}`);
    const mine = [];
    for (let k = 0; k < CHANNELS_PER_USER; k++) {
      const cid = channels[(i + k) % channels.length];
      mine.push(cid);
      (membersByChannel[cid] = membersByChannel[cid] || []).push(u.userId);
    }
    users.push({ token: u.token, userId: u.userId, channels: [...new Set(mine)] });
  }

  // Bulk-add members per channel (chunked) so each send fans out to real members.
  for (const cid of channels) {
    const ids = membersByChannel[cid] || [];
    for (let j = 0; j < ids.length; j += 50) {
      http.post(
        `${BASE}/channels/${cid}/members`,
        JSON.stringify({ userIds: ids.slice(j, j + 50) }),
        jsonHeaders(admin.token)
      );
    }
  }

  return { users };
}

function userFor(data) {
  const idx = (exec.vu.idInTest - 1) % data.users.length;
  return data.users[idx];
}

// Minimal Socket.IO v4 (Engine.IO 4) client over a raw websocket:
//   "0{...}"  engine OPEN          -> client sends "40{auth}" (CONNECT w/ auth)
//   "40{sid}" socket CONNECTED
//   "2"       engine PING          -> client replies "3" (PONG)
//   "42[...]" event (server->client)
//   client emits events as "42" + JSON.stringify([event, payload])
export function chatter(data) {
  const u = userFor(data);
  const url = `${WS_BASE}/socket.io/?EIO=4&transport=websocket`;

  const res = ws.connect(url, {}, (socket) => {
    let connected = false;

    socket.on("open", () => {
      socket.send("40" + JSON.stringify({ token: u.token, platform: "web" }));
    });

    socket.on("message", (m) => {
      if (!m) return;
      if (m === "2") return socket.send("3"); // ping -> pong
      if (m[0] === "4" && m[1] === "0") {
        connected = true;
        wsConnectOk.add(true);
        socket.send('42["channel:read",' + JSON.stringify({ channelId: u.channels[0] }) + "]");
        return;
      }
      if (m[0] === "4" && m[1] === "4") {
        wsErrors.add(1); // connect_error
        return;
      }
      if (m[0] === "4" && m[1] === "2") eventsReceived.add(1); // event
    });

    socket.setInterval(() => {
      if (connected) socket.send('42["activity"]');
    }, 15000);

    socket.setInterval(() => {
      if (!connected || u.channels.length === 0) return;
      const cid = pick(u.channels);
      socket.send("42" + JSON.stringify(["message:send", { channelId: cid, body: `charge ${Date.now()}` }]));
      messagesSent.add(1);
    }, randInt(3000, 7000));

    socket.setInterval(() => {
      if (!connected) return;
      const cid = pick(u.channels);
      socket.send("42" + JSON.stringify(["typing", { channelId: cid }]));
    }, 9000);

    // Cycle the connection every ~45-60s (realistic churn) then let the VU re-iterate.
    socket.setTimeout(() => socket.close(), randInt(45000, 60000));
    socket.on("error", () => wsErrors.add(1));
  });

  const ok = check(res, { "ws upgraded (101)": (r) => r && r.status === 101 });
  if (!ok) wsConnectOk.add(false);
}

export function reader(data) {
  const u = userFor(data);
  const h = jsonHeaders(u.token);

  check(http.get(`${BASE}/auth/me`, h), { "me 200": (r) => r.status === 200 });

  const chRes = http.get(`${BASE}/channels`, h);
  check(chRes, { "channels 200": (r) => r.status === 200 });

  let channels = [];
  try {
    channels = chRes.json().channels || [];
  } catch (e) {
    channels = [];
  }

  if (channels.length) {
    const c = pick(channels);
    const msgs = http.get(`${BASE}/channels/${c.id}/messages`, h);
    check(msgs, { "messages 200": (r) => r.status === 200 });
    let list = [];
    try {
      list = msgs.json().messages || [];
    } catch (e) {
      list = [];
    }
    if (list.length && Math.random() < 0.3) {
      const m = pick(list);
      http.post(
        `${BASE}/channels/messages/${m.id}/reactions`,
        JSON.stringify({ emoji: pick(["👍", "🔥", "🎉", "❤️"]) }),
        h
      );
    }
  }

  http.get(`${BASE}/channels/public`, h);
  if (Math.random() < 0.1) {
    http.post(`${BASE}/auth/dnd`, JSON.stringify({ minutes: pick([0, 30]) }), h);
  }

  sleep(randInt(1, 4));
}
