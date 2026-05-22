import { prisma } from "./db.js";
import { encryptBody } from "../../src/crypto.js";

// Insert a message row directly (bypassing the socket send path) so HTTP tests
// for edit/delete/thread/list/scheduled can set up state deterministically.
// Body is encrypted exactly as the app stores it.
export function seedMessage({ body = "message", delivered = true, ...rest }) {
  return prisma.message.create({
    data: { body: encryptBody(body), delivered, ...rest },
  });
}

export function seedReaction({ messageId, userId, emoji }) {
  return prisma.reaction.create({ data: { messageId, userId, emoji } });
}
