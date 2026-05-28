import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

const FTS_CONFIG = "french"; // matches the GIN index built in ensureSearchIndex()
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// Search messages within the channels the caller is a member of.
//   GET /search?q=hello world&channelId=optional&limit=30
// Returns the top-ranked delivered messages whose plaintext mirror matches the
// `plainto_tsquery` parsing of `q`, along with the channel + author for context.
router.get("/", requireAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.json({ results: [], total: 0 });

  const channelId = typeof req.query.channelId === "string" ? req.query.channelId : null;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
  );

  // Channels the caller can see (memberships). If a specific channel was
  // requested, narrow further — but still enforce membership.
  const memberships = await prisma.membership.findMany({
    where: { userId: req.userId, ...(channelId ? { channelId } : {}) },
    select: { channelId: true },
  });
  const channelIds = memberships.map((m) => m.channelId);
  if (channelIds.length === 0) return res.json({ results: [], total: 0 });

  // Raw SQL: Prisma can't model the FTS operator/expression. We bind `q` as a
  // parameter (no SQL injection); the IN(...) list comes from validated IDs.
  // `ts_headline` returns an HTML snippet with <mark> around matches.
  const placeholders = channelIds.map((_, i) => `$${i + 3}`).join(",");
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      m.id,
      m."channelId",
      m."authorId",
      m."createdAt",
      m."editedAt",
      m."parentId",
      m."searchableBody" AS snippet_src,
      ts_headline(${literal(FTS_CONFIG)}, m."searchableBody", plainto_tsquery(${literal(FTS_CONFIG)}, $1),
                  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=12, MinWords=4') AS snippet,
      ts_rank(to_tsvector(${literal(FTS_CONFIG)}, m."searchableBody"),
              plainto_tsquery(${literal(FTS_CONFIG)}, $1)) AS rank
    FROM "Message" m
    WHERE m.delivered = true
      AND m."searchableBody" IS NOT NULL
      AND m."channelId" IN (${placeholders})
      AND to_tsvector(${literal(FTS_CONFIG)}, m."searchableBody")
          @@ plainto_tsquery(${literal(FTS_CONFIG)}, $1)
    ORDER BY rank DESC, m."createdAt" DESC
    LIMIT $2
    `,
    q,
    limit,
    ...channelIds
  );

  // Hydrate the lightweight FTS rows with author + channel info so the UI can
  // render results without an extra round-trip.
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const lookupChannelIds = [...new Set(rows.map((r) => r.channelId))];
  const [authors, channels] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, displayName: true, username: true, avatarColor: true },
    }),
    prisma.channel.findMany({
      where: { id: { in: lookupChannelIds } },
      select: { id: true, name: true, isDirect: true },
    }),
  ]);
  const aById = Object.fromEntries(authors.map((a) => [a.id, a]));
  const cById = Object.fromEntries(channels.map((c) => [c.id, c]));

  res.json({
    q,
    results: rows.map((r) => ({
      id: r.id,
      channelId: r.channelId,
      channel: cById[r.channelId] || null,
      author: aById[r.authorId] || null,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      parentId: r.parentId,
      snippet: r.snippet, // HTML with <mark> around matches
      score: Number(r.rank),
    })),
    total: rows.length,
  });
});

// Safety: only literal SQL identifiers/regconfigs accepted (no user input).
function literal(s) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`bad literal: ${s}`);
  return `'${s}'`;
}

// Ensure the FTS index exists. Idempotent — safe to call on every boot.
// Uses an expression index over `to_tsvector` so we never need a stored
// tsvector column (the @@ operator in the search query uses the same
// expression and hits the index directly).
export async function ensureSearchIndex() {
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Message_searchableBody_fts_idx"
    ON "Message"
    USING GIN (to_tsvector('french', "searchableBody"));
  `);
}

export default router;
