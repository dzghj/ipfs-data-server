-- Envelope encryption for per-file AES keys (see secure-share/key-wrap.js).
--
-- FileRecords.encryptionKey used to always be a raw AES key, base64-encoded,
-- sitting in Postgres as plaintext. Going forward, if FILE_ENCRYPTION_KEY is
-- configured (a Render env var), new uploads wrap that key with AES-256-GCM
-- under it before storing — a database leak alone no longer hands over
-- every file's key, since FILE_ENCRYPTION_KEY lives outside the database.
--
-- keyWrapped distinguishes the two cases per row. Existing rows default to
-- false (legacy plaintext) and keep decrypting exactly as before — no
-- backfill required. resolveFileKey() in secure-share/key-wrap.js is what
-- reads this flag to decide whether to unwrap or just base64-decode.

ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "keyWrapped" BOOLEAN NOT NULL DEFAULT false;
