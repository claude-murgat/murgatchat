-- Admins du salon : rôle par membre ("admin" | "member"). Additif : tout le monde
-- part "member" ; chaque salon existant reçoit son admin au démarrage du serveur
-- (ensureSalonAdmins, routes/channels.ts), pas ici — le choix dépend du bot et du
-- nom du salon du pipeline, que seul le code connaît.
ALTER TABLE "Membership" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member';
