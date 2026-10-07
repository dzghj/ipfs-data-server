// Envelope encryption for per-file AES keys — the simple version.
//
// Each file still gets its own random AES-256 key (crypto-utils.js's
// generateKey()) — but instead of that raw key sitting in Postgres as
// plaintext base64, it's wrapped (re-encrypted) with a single master key
// read from the FILE_ENCRYPTION_KEY env var before being stored. A DB leak
// alone — a stolen backup, a leaked connection string, a rogue query — no
// longer hands over every file's key; the attacker also needs this one
// Render env var, which lives outside the database.
//
// This does not protect against a full app-server compromise (anyone who
// can read the running process's env can read FILE_ENCRYPTION_KEY too) —
// a cloud KMS would add that, at the cost of a cloud project/key
// ring/service account to set up and maintain. Given how this project
// actually runs day to day, that complexity wasn't worth it; this is the
// simple version, deliberately: one new Render secret, no other setup.
//
// FileRecord.keyWrapped distinguishes wrapped rows (FILE_ENCRYPTION_KEY was
// set at upload time) from legacy plaintext rows — resolveFileKey() handles
// both transparently, no backfill required.
//
// Fails CLOSED, not open: if a row is marked keyWrapped but
// FILE_ENCRYPTION_KEY isn't set, this throws rather than silently assuming
// plaintext — a security control that silently degrades on error isn't one.

import crypto from "crypto";

if (!process.env.FILE_ENCRYPTION_KEY) {
  console.warn(
    "⚠️  FILE_ENCRYPTION_KEY not set — new file keys will be stored in " +
    "plaintext (envelope encryption disabled). Existing wrapped files, if any, still decrypt fine."
  );
}

// FILE_ENCRYPTION_KEY must be a base64 string decoding to exactly 32 bytes,
// e.g. generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function masterKey() {
  const raw = process.env.FILE_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("FILE_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)");
  }
  return key;
}

/**
 * Wrap a raw per-file AES key with the master key, if configured.
 * @param {Buffer} rawKey
 * @returns {{ value: string, wrapped: boolean }}
 *          value is base64; wrapped tells the caller what to store in
 *          FileRecord.keyWrapped — false means FILE_ENCRYPTION_KEY isn't set
 *          and this is just the old plaintext-base64 behavior, unchanged.
 */
export function wrapKey(rawKey) {
  const key = masterKey();
  if (!key) return { value: rawKey.toString("base64"), wrapped: false };

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(rawKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Self-contained blob: iv (12) + authTag (16) + ciphertext — nothing extra
  // to store, so no new columns beyond keyWrapped.
  const value = Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  return { value, wrapped: true };
}

/**
 * Unwrap a wrapped per-file key back to its raw bytes.
 * @param {string} wrappedBase64
 * @returns {Buffer}
 */
export function unwrapKey(wrappedBase64) {
  const key = masterKey();
  if (!key) {
    throw new Error("FILE_ENCRYPTION_KEY not configured — cannot unwrap a wrapped key");
  }
  const buf = Buffer.from(wrappedBase64, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Resolve a FileRecord's actual per-file AES key, transparently handling
 * both legacy plaintext rows (keyWrapped: false) and wrapped rows.
 * @param {{ encryptionKey: string, keyWrapped?: boolean }} file
 * @returns {Buffer}
 */
export function resolveFileKey(file) {
  if (!file.keyWrapped) return Buffer.from(file.encryptionKey, "base64");
  return unwrapKey(file.encryptionKey);
}
