-- Expert consulté dans un canal kind="claude" (clé du registre src/experts.ts :
-- "supervision", "management"…). Additif : null pour les salons et les DM.
ALTER TABLE "Channel" ADD COLUMN "expert" TEXT;
-- Toutes les conversations existantes sont celles de l'expert supervision, et
-- leur description devient le sous-titre d'en-tête affiché par le client.
UPDATE "Channel" SET "expert" = 'supervision' WHERE "kind" = 'claude' AND "expert" IS NULL;
UPDATE "Channel" SET "description" = 'Expert de l''application SUPERVISION' WHERE "kind" = 'claude';
