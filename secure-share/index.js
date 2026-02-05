import { ipfs } from "./ipfs-client.js";
import { generateKey, encrypt, decrypt, sha256 } from "./crypto-utils.js";
import { encryptForUser } from "./user-keys.js";
import { SharedKey, FileRecord, AccessLog } from "../db.js";

/* ===== Secure Upload ===== */
export async function secureUpload({ buffer, filename, ownerId, mimeType }) {
  const fileKey = generateKey();
  const { encrypted, iv, authTag } = encrypt(buffer, fileKey);
  const hash = sha256(buffer);

  // Upload to IPFS
  const upload = await ipfs.add(encrypted);
  const cid = upload.cid.toString();

  // Save audit log
  await AccessLog.create({ actorEmail: ownerId.toString(), role: "user", action: "UPLOAD", note: filename });

  return {
    cid,
    sha256Hash: hash,
    encryptedFileKey: fileKey.toString("base64"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/* ===== Share File ===== */
export async function shareFile({ cid, fileKey, userId, userPublicKey, ttlMinutes }) {
  const encryptedKey = encryptForUser(fileKey, userPublicKey);
  const expiresAt = ttlMinutes ? Date.now() + ttlMinutes*60*1000 : null;

  // Save in DB
  await SharedKey.create({ fileId: cid, keyholderId: userId, encryptedKey: encryptedKey.toString("base64") });

  // Audit
  await AccessLog.create({ actorEmail: userId.toString(), role: "system", action: "GRANT_ACCESS", note: cid });
}

/* ===== TODO: batchShare / revoke / rotate keys ===== */