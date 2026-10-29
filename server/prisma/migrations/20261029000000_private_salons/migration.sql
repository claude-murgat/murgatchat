-- Salons privés gérés par leurs membres (1.6.0).

-- Messages de service (« Charles a ajouté Bob ») : jamais notifiés ni comptés
-- comme non lus. Additif : les messages existants restent des messages ordinaires.
ALTER TABLE "Message" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user';

-- « Masquer » une conversation directe, par membre. Additif et nullable.
ALTER TABLE "Membership" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- Les groupes de discussion (DM à trois personnes ou plus) deviennent des salons
-- privés, gérables par leurs membres. Le nom reprend les membres, par ordre
-- alphabétique (80 caractères au plus, la limite d'un nom de salon) ; messages,
-- pièces jointes, membres et non-lus sont conservés. Les DM à deux, les notes
-- personnelles et les conversations d'expert Claude ne sont pas touchés.
UPDATE "Channel" AS c
SET "isDirect" = false,
    "isPrivate" = true,
    "name" = CASE WHEN char_length(g.names) > 80 THEN left(g.names, 79) || '…' ELSE g.names END
FROM (
    SELECT m."channelId",
           string_agg(u."displayName", ', ' ORDER BY lower(u."displayName"), u."id") AS names
    FROM "Membership" m
    JOIN "User" u ON u."id" = m."userId"
    GROUP BY m."channelId"
    HAVING count(*) >= 3
) AS g
WHERE c."id" = g."channelId"
  AND c."isDirect" = true
  AND c."kind" = 'standard';
