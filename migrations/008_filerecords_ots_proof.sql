-- OpenTimestamps anchor for FileRecords.sha256Hash (see secure-share/anchor.js).
--
-- On upload, secureUpload()/secureUploadClientEncrypted() stamp the file's
-- SHA-256 with the OpenTimestamps calendars and store the resulting .ots proof
-- (base64) in otsProof. That proof starts as a calendar commitment; a few
-- hours later it can be "upgraded" to include a Bitcoin attestation
-- (otsUpgradedAt is set when that happens, via the lazy upgrade in
-- GET /api/file/:id/proof* or POST /api/internal/ots/upgrade-pending).
--
-- Once upgraded, anyone can verify the file's timestamp against the Bitcoin
-- blockchain WITHOUT trusting this server or its database.

ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "otsProof"      TEXT;
ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "otsAnchoredAt" TIMESTAMP WITH TIME ZONE;
ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "otsUpgradedAt" TIMESTAMP WITH TIME ZONE;

-- Existing files were never stamped; leave otsProof NULL. To backfill, re-stamp
-- their sha256Hash values with the `ots` CLI or a one-off script.
