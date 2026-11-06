-- Accusés de lecture : dernier message affiché à l'écran du membre. Additif et
-- vide au départ : seul un affichage réel le renseigne (rien n'est déduit de
-- `lastReadAt`, qu'une ouverture ou « Marquer comme lu » avancent sans affichage).
ALTER TABLE "Membership" ADD COLUMN "seenAt" TIMESTAMP(3);
