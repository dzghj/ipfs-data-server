import cors from "cors";
import bodyParser from "body-parser";
import express from "express";
import multer from "multer";
import dotenv from "dotenv";

import authRoutes, { auth } from "./auth.js";
import { sequelize, FileRecord } from "./db.js";
import { secureUpload } from "./secure-share/index.js";
import { ipfs } from "./secure-share/ipfs-client.js";
import { decrypt } from "./secure-share/crypto-Utils.js";



import fetch from "node-fetch"; // only if Node <20


dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ===== Multer Memory ===== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

/* ===== Routes ===== */
app.use("/api/auth", authRoutes);

console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("DATABASE_URL loaded:", !!process.env.DATABASE_URL);
/* ===== health check ===== */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    env: process.env.NODE_ENV
  });
});


/* ===== Upload Route ===== */
app.post("/api/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const allowedMimeTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "text/plain"
    ];

    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ message: "Unsupported file type" });
    }

    // Optional: sanitize filename
    const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");

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
      iv: result.iv, // hex string    
      authTag: result.authTag, // hex string   
      mimeType: req.file.mimetype,
      uploadedAt: new Date(),
    });

    res.json({
      success: true,
      file: {
        id: record.id,
        filename: record.filename,
        cid: record.cid
      }
    });

  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});
/* ===== view Route ===== */

app.get("/api/file/:id/view", auth, async (req, res) => {
  try {
    const file = await FileRecord.findOne({
      where: { id: req.params.id, userId: req.user.id }
    });

    if (!file) return res.status(404).json({ message: "File not found" });

    // ⬇️ Download encrypted file from IPFS
    const chunks = [];
    for await (const chunk of ipfs.cat(file.cid)) chunks.push(chunk);
    const encryptedBuffer = Buffer.concat(chunks);

    // 🔑 Convert stored values to buffers
    const key = Buffer.from(file.encryptionKey, "base64");
    const iv = Buffer.from(file.iv, "hex");
    const authTag = Buffer.from(file.authTag, "hex");
   

    // 🔓 Decrypt
    const decryptedBuffer = decrypt(encryptedBuffer, key, iv, authTag);

    // 🔐 Log access
    await AccessLog.create({
      actorEmail: req.user.email,
      role: "User",
      action: "VIEW_FILE",
      fileId: file.id,
      ipAddress: req.ip,
      note: "File viewed"
    });

    // 📤 Send file inline (any type)
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${file.filename}"`
    );

    res.send(decryptedBuffer);

  } catch (err) {
    console.error("View file failed:", err);
    res.status(500).json({ message: "View failed" });
  }
});

/* ===== My Files ===== */
app.get("/api/myfiles", auth, async (req, res) => {
  try {
    const files = await FileRecord.findAll({
      where: { userId: req.user.id },
      order: [["uploadedAt", "DESC"]],
      attributes: ["id", "filename", "cid", "uploadedAt"]
    });

    res.json({ success: true, files });
  } catch (err) {
    console.error("Fetch files failed:", err);
    res.status(500).json({ message: "Failed to fetch files" });
  }
});
/* ===== Boot Server ===== */
const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to database");

    // 🔐 IMPORTANT: never auto-sync in production
    if (process.env.NODE_ENV !== "production") {
      console.log("🛠 Running sequelize.sync() (dev only)");
      await sequelize.sync();
    } else {
      console.log("🚫 Skipping sequelize.sync() in production");
    }

    app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
});
  } catch (err) {
    console.error("❌ Server startup failed:", err);
    process.exit(1);
  }
})();
