import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";

import authRoutes, { auth } from "./auth.js";
import { sequelize, FileRecord } from "./db.js";
import { secureUpload } from "./secure-share/index.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ===== Multer Memory ===== */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024 } });

/* ===== Routes ===== */
app.use("/api/auth", authRoutes);

/* ===== Upload Route ===== */
app.post("/api/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const result = await secureUpload({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      ownerId: req.user.id,
      mimeType: req.file.mimetype,
    });

    const record = await FileRecord.create({
      userId: req.user.id,
      filename: req.file.originalname,
      cid: result.cid,
      sha256Hash: result.sha256Hash,
      encryptionKey: result.encryptedFileKey,
      uploadedAt: new Date(),
    });

    res.json({ success: true, file: { id: record.id, filename: record.filename, cid: record.cid } });

  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

/* ===== Boot Server ===== */
const PORT = process.env.PORT || 4000;
(async () => {
  await sequelize.authenticate();
  await sequelize.sync();
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
})();
