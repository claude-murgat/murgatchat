import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import { sendWebPush } from "../../src/webpush.ts";

// Clés VAPID fournies par l'environnement : sans elles, initWebPush en
// générerait et les écrirait dans server/data/vapid.json.
beforeAll(() => {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Abonnement au format navigateur (clé P-256 non compressée + secret de 16
// octets) : web-push peut réellement chiffrer la charge utile pour lui.
function subscription(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    p256dh: ecdh.getPublicKey("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

const payload = { title: "Alice", body: "coucou", channelId: "c1", tag: "channel:c1" };

describe("sendWebPush", () => {
  it("sends Urgency: high and a 24 h TTL, without Topic, with a request timeout", async () => {
    const sent = [];
    vi.spyOn(webpush, "sendNotification").mockImplementation(async (sub, body, options) => {
      // Les en-têtes que web-push enverrait vraiment au service push pour cet appel.
      const { headers } = webpush.generateRequestDetails(sub, body, options);
      sent.push({ headers, options });
      return { statusCode: 201, body: "", headers: {} };
    });

    const res = await sendWebPush([subscription("https://fcm.googleapis.com/fcm/send/a")], payload);

    expect(res).toEqual({ sent: 1, pruned: 0 });
    expect(sent).toHaveLength(1);
    // Sans `Urgency: high`, FCM livre en priorité normale : Android diffère le
    // message jusqu'à la fenêtre de maintenance Doze suivante.
    expect(sent[0].headers.Urgency).toBe("high");
    expect(sent[0].headers.TTL).toBe(86400);
    // Un Topic ferait remplacer un message en attente par le suivant.
    expect(sent[0].headers).not.toHaveProperty("Topic");
    expect(sent[0].headers.Authorization).toMatch(/^vapid /);
    expect(sent[0].options.timeout).toBeGreaterThan(0);
  });

  it("doesn't let a slow push service hold back the other subscriptions", async () => {
    const started = [];
    let releaseSlow;
    vi.spyOn(webpush, "sendNotification").mockImplementation((sub) => {
      started.push(sub.endpoint);
      if (sub.endpoint.endsWith("/slow")) {
        return new Promise((resolve) => {
          releaseSlow = () => resolve({ statusCode: 201, body: "", headers: {} });
        });
      }
      return Promise.resolve({ statusCode: 201, body: "", headers: {} });
    });

    const pending = sendWebPush(
      [
        subscription("https://fcm.googleapis.com/fcm/send/slow"),
        subscription("https://web.push.apple.com/fast"),
      ],
      payload
    );
    // Les deux envois sont partis alors que le premier service n'a pas répondu.
    expect(started).toEqual([
      "https://fcm.googleapis.com/fcm/send/slow",
      "https://web.push.apple.com/fast",
    ]);
    releaseSlow();
    expect(await pending).toEqual({ sent: 2, pruned: 0 });
  });
});
