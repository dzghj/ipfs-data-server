import { Router } from "express";
import multer from "multer";
import { auth } from "../auth.js";
import { FileRecord, Nominee } from "../db.js";
import { secureUpload, secureView, secureFetchEncrypted } from "../secure-share/index.js";
import { encryptForUser } from "../secure-share/user-keys.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "text/plain",
];

// POST /api/upload
router.post("/upload", auth, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ message: "Unsupported file type" });
    }

    const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const category = req.body.category || "Personal";

    const result = await secureUpload({
      buffer: req.file.buffer,
      filename: safeFilename,
      ownerId: req.user.id,
      mimeType: req.file.mimetype,
    });

    const record = await FileRecord.create({
      userId: req.user.id,
      filename: safeFilename,
      cid: result.cid,
      sha256Hash: result.sha256Hash,
      encryptionKey: result.encryptedFileKey,
      iv: result.iv,
      authTag: result.authTag,
      mimeType: req.file.mimetype,
      category,
      uploadedAt: new Date(),
    });

    res.json({ success: true, file: { id: record.id, filename: record.filename, cid: record.cid } });
  } catch (err) {
    next(err);
  }
});

// GET /api/myfiles
router.get("/myfiles", auth, async (req, res, next) => {
  try {
    // If user is an owner, return their files. If user is a nominee, return allowed files from owner.
    const ownerFiles = await FileRecord.findAll({
      where: { userId: req.user.id },
      order: [["uploadedAt", "DESC"]],
      attributes: ["id", "filename", "cid", "uploadedAt", "protectionOn", "keyHolderList", "category", "mimeType"],
    });

    if (ownerFiles && ownerFiles.length > 0) {
      return res.json({ success: true, files: ownerFiles });
    }

    // Not owner files — check if this user is registered as a nominee for someone
    const nominee = await Nominee.findOne({ where: { nomineeAccountId: req.user.id } });
    if (!nominee) return res.json({ success: true, files: [] });

    const where = { userId: nominee.userId };
    if (nominee.accessLevel === "partial") {
      // we'll filter by category after fetching
    }

    const filesForOwner = await FileRecord.findAll({ where, order: [["uploadedAt", "DESC"]] });
    const files = filesForOwner.filter((f) => {
      if (nominee.accessLevel === "full") return true;
      const allowed = nominee.allowedFolders || [];
      return allowed.includes(f.category);
    }).map((f) => ({ id: f.id, filename: f.filename, cid: f.cid, uploadedAt: f.uploadedAt, protectionOn: f.protectionOn, keyHolderList: f.keyHolderList, category: f.category, mimeType: f.mimeType }));

    res.json({ success: true, files });
  } catch (err) {
    next(err);
  }
});

// GET /api/file/:id/view
router.get("/file/:id/view", auth, async (req, res, next) => {
  try {
    const result = await secureView({ fileId: req.params.id, user: req.user });

    if (!result?.buffer) return res.status(404).json({ message: "File not found" });

    res.json({
      integrityVerified: Boolean(result.integrityVerified),
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.buffer.length,
      data: result.buffer.toString("base64"),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/file/:id/download-encrypted  — return raw encrypted bytes (owner or nominee)
router.get("/file/:id/download-encrypted", auth, async (req, res, next) => {
  try {
    const { encryptedBuffer, mimeType, filename, iv, authTag } = await secureFetchEncrypted({ fileId: req.params.id, user: req.user });
    res.json({ success: true, filename, mimeType, data: encryptedBuffer.toString("base64"), iv, authTag });
  } catch (err) {
    next(err);
  }
});

// GET /api/file/:id/nominee-key  — return symmetric file key encrypted to nominee public key
router.get("/file/:id/nominee-key", auth, async (req, res, next) => {
  try {
    const file = await FileRecord.findOne({ where: { id: req.params.id } });
    if (!file) return res.status(404).json({ message: "File not found" });

    const nominee = await Nominee.findOne({ where: { userId: file.userId, nomineeAccountId: req.user.id } });
    if (!nominee) return res.status(403).json({ message: "Not authorized" });

    if (nominee.accessLevel === "partial") {
      const allowed = nominee.allowedFolders || [];
      if (!allowed.includes(file.category)) return res.status(403).json({ message: "Not authorized" });
    }

    if (!nominee.publicKey) return res.status(400).json({ message: "Nominee does not have a public key set" });

    const symKey = Buffer.from(file.encryptionKey, "base64");
    const encrypted = encryptForUser(symKey, nominee.publicKey);

    res.json({ success: true, encryptedKey: encrypted.toString("base64") });
  } catch (err) {
    next(err);
  }
});

// POST /api/file/:id/keyholders
router.post("/file/:id/keyholders", auth, async (req, res, next) => {
  try {
    const { keyHolderList } = req.body;

    if (!Array.isArray(keyHolderList)) {
      return res.status(400).json({ message: "keyHolderList must be an array" });
    }
    if (keyHolderList.length > 3) {
      return res.status(400).json({ message: "Maximum 3 keyholders allowed" });
    }

    const file = await FileRecord.findOne({ where: { id: req.params.id } });
    if (!file) return res.status(404).json({ message: "File not found" });
    if (file.userId !== req.user.id) return res.status(403).json({ message: "Not authorized" });

    file.keyHolderList = keyHolderList;
    await file.save();

    res.json({ success: true, keyHolderList: file.keyHolderList });
  } catch (err) {
    next(err);
  }
});

// POST /api/file/:id/toggle-protection
router.post("/file/:id/toggle-protection", auth, async (req, res, next) => {
  try {
    const file = await FileRecord.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!file) return res.status(404).json({ message: "File not found" });

    file.protectionOn = req.body.enabled;
    await file.save();

    res.json({ success: true, protectionOn: file.protectionOn });
  } catch (err) {
    next(err);
  }
});

export default router;
