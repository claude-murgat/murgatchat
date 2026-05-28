import { prisma } from "./db.js";
import { encryptBody } from "../../src/crypto.js";

// Insert a message row directly (bypassing the socket send path) so HTTP tests
// for edit/delete/thread/list/scheduled can set up state deterministically.
// Body is encrypted exactly as the app stores it.
export function seedMessage({ body = "message", delivered = true, ...rest }) {
  return prisma.message.create({
    // Mirror the live write path: encrypt the body AND populate searchableBody
    // so HTTP tests can hit the FTS endpoint without extra plumbing.
    data: { body: encryptBody(body), searchableBody: body, delivered, ...rest },
  });
}

export function seedReaction({ messageId, userId, emoji }) {
  return prisma.reaction.create({ data: { messageId, userId, emoji } });
}
