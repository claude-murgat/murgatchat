-- La relation Attachment.user est déclarée `onDelete: SetNull` (une capture
-- jointe à un rapport de bug survit à son auteur), mais la colonne était restée
-- NOT NULL : toute suppression définitive d'un utilisateur ayant envoyé un
-- fichier échouait sur la contrainte. Sans réécriture des lignes existantes.
ALTER TABLE "Attachment" ALTER COLUMN "uploadedBy" DROP NOT NULL;
