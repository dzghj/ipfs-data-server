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
  // pin 
  await ipfs.pin.add(upload.cid);

  // Save audit log
  await AccessLog.create({ actorEmail: ownerId.toString(), role: "user", action: "UPLOAD", note: filename });

  return {
    cid,
    sha256Hash: hash,
    encryptedFileKey: fileKey.toString("base64"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    filename,
    ownerId,
   mimeType,
  };
}
/* ===== Secure View ===== */
export async function secureView({ fileId, user }) {
  // 1️⃣ Find file (ownership enforced)
  const file = await FileRecord.findOne({
    where: { id: fileId, userId: user.id }
  });

  if (!file) {
    throw new Error("File not found");
  }

  // 2️⃣ Download encrypted file from IPFS
  const chunks = [];
  for await (const chunk of ipfs.cat(file.cid)) {
    chunks.push(chunk);
  }
  const encryptedBuffer = Buffer.concat(chunks);

  // 3️⃣ Convert stored crypto values
  const key = Buffer.from(file.encryptionKey, "base64");
  const iv = Buffer.from(file.iv, "hex");
  const authTag = Buffer.from(file.authTag, "hex");

  // 4️⃣ Decrypt
  const decryptedBuffer = decrypt(encryptedBuffer, key, iv, authTag);

  // 5️⃣ Log access
  await AccessLog.create({
    actorEmail: user.email,
    role: "User",
    action: "VIEW_FILE",
    fileId: file.id,
    ipAddress: null,
    note: "File viewed"
  });

  return {
    buffer: decryptedBuffer,
    mimeType: file.mimeType || "application/octet-stream",
    filename: file.filename
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