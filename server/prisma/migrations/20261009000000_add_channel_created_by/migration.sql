-- Createur du salon (POST /channels) : seul lui (ou un admin) peut le renommer ou le supprimer.
-- Additif et nullable : les salons historiques gardent NULL (geres par les admins).
ALTER TABLE "Channel" ADD COLUMN "createdById" TEXT;
