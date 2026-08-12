import { ipfs } from "./ipfs-client.js";
import { generateKey, encrypt, decrypt, sha256 } from "./crypto-utils.js";
import { FileRecord, AccessLog, Nominee } from "../db.js";
import crypto from "crypto";

// ── Cluster pin helper ────────────────────────────────────────────────────────
// After uploading to IPFS, pin via the cluster REST API so the file is
// replicated across all cluster nodes (replication factor 2).
async function clusterPin(cid) {
  const clusterUrl = process.env.CLUSTER_API_URL;         // e.g. http://104.198.148.182:9094
  const clusterUser = process.env.CLUSTER_API_USER || "admin";
  const clusterPass = process.env.CLUSTER_API_PASSWORD || "";

  if (!clusterUrl) {
    console.warn("⚠️  CLUSTER_API_URL not set — skipping cluster pin (single-node only)");
    return;
  }

  try {
    const credentials = Buffer.from(`${clusterUser}:${clusterPass}`).toString("base64");
    const res = await fetch(`${clusterUrl}/pins/${cid}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`⚠️  Cluster pin failed for ${cid}: ${res.status} ${body}`);
    } else {
      console.log(`✅ Cluster pin queued for ${cid}`);
    }
  } catch (err) {
    // Non-fatal — file is already on IPFS, cluster pin is best-effort
    console.error(`⚠️  Cluster pin error for ${cid}:`, err.message);
  }
}

/* ===== Secure Upload ===== */
export async function secureUpload({ buffer, filename, ownerId, mimeType }) {
  const fileKey = generateKey();
  const { encrypted, iv, authTag } = encrypt(buffer, fileKey);
  const hash = sha256(buffer);

  // Upload to IPFS
  const upload = await ipfs.add(encrypted);
 
  const cid = upload.cid.toString();
  // pin locally
  await ipfs.pin.add(upload.cid);

  // pin across cluster (replicates to all cluster nodes)
  await clusterPin(cid);

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
  const file = await FileRecord.findOne({ where: { id: fileId } });

  if (!file) {
    console.error("File not found:", fileId);
    throw new Error("File not found");
  }

  // Only owner may request decrypted file bytes via secureView
  if (!user || user.id !== file.userId) {
    throw new Error("Not authorized");
  }

  const chunks = [];
  for await (const chunk of ipfs.cat(file.cid)) {
    chunks.push(chunk);
  }

  const encryptedBuffer = Buffer.concat(chunks);
  
  const key = Buffer.from(file.encryptionKey, "base64");
  const iv = Buffer.from(file.iv, "hex");
  const authTag = Buffer.from(file.authTag, "hex");

  const decryptedBuffer = decrypt(encryptedBuffer, key, iv, authTag);
  
  const recalculatedHash = crypto
    .createHash("sha256")
    .update(decryptedBuffer)
    .digest("hex");

  let integrityVerified = true;
  let integrityNote = "Integrity verified";

  if (recalculatedHash !== file.sha256Hash) {
    integrityVerified = false;
    integrityNote = "WARNING: SHA256 hash mismatch detected";
  }

  await AccessLog.create({
    actorEmail: user?.email || null,
    role: "User",
    action: "VIEW_FILE",
    fileId: file.id,
    ipAddress: null,
    note: integrityNote
  });

  return {
    buffer: decryptedBuffer,
    mimeType: file.mimeType || "application/octet-stream",
    filename: file.filename,
    sha256Hash: recalculatedHash,
    integrityVerified
  };
}

// Return the raw encrypted bytes from IPFS (no decryption). Access allowed for owner or nominee.
export async function secureFetchEncrypted({ fileId, user }) {
  const file = await FileRecord.findOne({ where: { id: fileId } });
  if (!file) throw new Error("File not found");

  if (user.id !== file.userId) {
    const nominee = await Nominee.findOne({ where: { userId: file.userId, nomineeAccountId: user.id } });
    if (!nominee) throw new Error("Not authorized");
    if (nominee.accessLevel === "partial") {
      const allowed = nominee.allowedFolders || [];
      if (!allowed.includes(file.category)) throw new Error("Not authorized");
    }
  }

  const chunks = [];
  for await (const chunk of ipfs.cat(file.cid)) {
    chunks.push(chunk);
  }
  const encryptedBuffer = Buffer.concat(chunks);

  await AccessLog.create({
    actorEmail: user?.email || null,
    role: user.id === file.userId ? "User" : "Nominee",
    action: "FETCH_ENCRYPTED",
    fileId: file.id,
    ipAddress: null,
    note: "Encrypted file fetched",
  });

  return { encryptedBuffer, mimeType: file.mimeType || "application/octet-stream", filename: file.filename, iv: file.iv, authTag: file.authTag };
}

/* ===== Share File (not currently used) ===== */
export async function shareFile() {
  throw new Error("shareFile is not implemented");
}

/* ===== TODO: batchShare / revoke / rotate keys ===== */