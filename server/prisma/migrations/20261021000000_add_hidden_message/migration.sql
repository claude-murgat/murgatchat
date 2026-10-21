-- « Supprimer pour moi » : messages masqués pour un seul utilisateur.
-- Additif : aucune donnée existante touchée ; supprimé en cascade avec le message ou le compte.
CREATE TABLE "HiddenMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiddenMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HiddenMessage_messageId_idx" ON "HiddenMessage"("messageId");

CREATE UNIQUE INDEX "HiddenMessage_userId_messageId_key" ON "HiddenMessage"("userId", "messageId");

ALTER TABLE "HiddenMessage" ADD CONSTRAINT "HiddenMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HiddenMessage" ADD CONSTRAINT "HiddenMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
