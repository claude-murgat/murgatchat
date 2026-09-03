-- Nature du canal : "standard" | "claude" (conversation avec l'expert Claude).
-- Additif et rétro-compatible : tous les canaux existants restent "standard".
ALTER TABLE "Channel" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'standard';
