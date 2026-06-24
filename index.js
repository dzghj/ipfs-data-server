import cors from "cors";
import bodyParser from "body-parser";
import express from "express";
import multer from "multer";
import dotenv from "dotenv";

import authRoutes, { auth } from "./auth.js";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { sequelize, FileRecord, User, Plan, Nominee, Folder, AccessLog } from "./db.js";
import { secureUpload, secureView } from "./secure-share/index.js";
import { ipfs } from "./secure-share/ipfs-client.js";
import { decrypt } from "./secure-share/crypto-utils.js";



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
      category: req.body.category || "Personal",
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
      category: req.body.category || "Personal",
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
    const result = await secureView({
      fileId: req.params.id,
      user: req.user,
    });

    if (!result || !result.buffer) {
      return res.status(404).json({
        message: "File not found",
      });
    }

    res.status(200).json({
      integrityVerified: Boolean(result.integrityVerified),
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.buffer.length,
      data: result.buffer.toString("base64"),
    });

  } catch (err) {
    console.error("View file failed:", err);

    res.status(500).json({
      message: err.message || "Secure view failed",
    });
  }
});

/* ===== Update KeyHolder Emails ===== */

app.post("/api/file/:id/keyholders", auth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const { keyHolderList } = req.body;

    // ✅ Validate input
    if (!Array.isArray(keyHolderList)) {
      return res.status(400).json({
        message: "keyHolderList must be an array",
      });
    }

    // Optional: limit number of emails
    if (keyHolderList.length > 3) {
      return res.status(400).json({
        message: "Maximum 3 keyholders allowed",
      });
    }

    // ✅ Find file (ensure user owns it OR is allowed)
    const file = await FileRecord.findOne({
      where: { id: fileId },
    });

    if (!file) {
      return res.status(404).json({
        message: "File not found",
      });
    }

    // Optional security check (recommended)
    if (file.userId && file.userId !== req.user.id) {
      return res.status(403).json({
        message: "Not authorized",
      });
    }

    // ✅ Update JSONB field
    file.keyHolderList = keyHolderList;
    await file.save();

    res.status(200).json({
      success: true,
      keyHolderList: file.keyHolderList,
    });

  } catch (err) {
    console.error("Update keyholders failed:", err);

    res.status(500).json({
      message: err.message || "Failed to update keyholders",
    });
  }
});

/* ===== Toggle File Protection ===== */
app.post("/api/file/:id/toggle-protection", auth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const { enabled } = req.body;

    const file = await FileRecord.findOne({
      where: {
        id: fileId,
        userId: req.user.id, // security: only owner can change
      },
    });

    if (!file) {
      return res.status(404).json({
        message: "File not found",
      });
    }

    // Update protection flag
    file.protectionOn = enabled;
    await file.save();

    res.json({
      success: true,
      protectionOn: file.protectionOn,
    });

  } catch (err) {
    console.error("Toggle protection failed:", err);
    res.status(500).json({
      message: "Failed to update protection",
    });
  }
});

/* ===== My Files ===== */
app.get("/api/myfiles", auth, async (req, res) => {
  try {
    const files = await FileRecord.findAll({
      where: { userId: req.user.id },
      order: [["uploadedAt", "DESC"]],
      attributes: ["id", "filename", "cid", "uploadedAt", "protectionOn", "keyHolderList", "category", "mimeType"]
    });

    res.json({ success: true, files });
  } catch (err) {
    console.error("Fetch files failed:", err);
    res.status(500).json({ message: "Failed to fetch files" });
  }
});
/* ==============================
   SUBSCRIBE / UPGRADE PLAN
================================ */
app.post("/api/upgrade/subscribe", auth,async (req, res) => {
  try {
    const { planId } = req.body;

    // Get user from token (assumes you already use auth middleware)
    const userId = req.user.id;

    if (!planId) {
      return res.status(400).json({ message: "Plan ID is required" });
    }

    // Find selected plan
    const plan = await Plan.findOne({ where: { id: planId } });

    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    /* =========================
       STRIPE PAYMENT (LATER)
    ========================= */
    // TODO: integrate Stripe payment here

    /* =========================
       UPDATE USER PLAN
    ========================= */
    await User.update(
      { maxFileNumber: plan.maxFiles, planId: plan.id },
      { where: { id: userId } }
    );
  
    res.json({
      success: true,
      maxFiles: plan.maxFiles,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Subscription failed" });
  }
});

/* ==============================
   GET UPGRADE PLANS
================================ */
app.get("/api/upgrade/options", auth,async (req, res) => {
  try {
    const plans = await Plan.findAll({
      attributes: ["id", "name", "maxFiles", "price"],
      order: [["id", "ASC"]],
    });

    res.json({
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        maxFiles: p.maxFiles,
        price: p.price,
      })),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load upgrade plans" });
  }
});

/* ===== Folders CRUD ===== */

app.get("/api/folders", auth, async (req, res) => {
  try {
    const folders = await Folder.findAll({
      where: { userId: req.user.id },
      order: [["createdAt", "ASC"]],
      attributes: ["id", "name", "createdAt"],
    });
    res.json({ success: true, folders });
  } catch (err) {
    console.error("Fetch folders failed:", err);
    res.status(500).json({ message: "Failed to fetch folders" });
  }
});

app.post("/api/folders", auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Folder name required" });

    // Check duplicate
    const existing = await Folder.findOne({ where: { userId: req.user.id, name } });
    if (existing) return res.status(409).json({ message: `"${name}" folder already exists` });

    const folder = await Folder.create({ userId: req.user.id, name });
    res.status(201).json({ success: true, folder });
  } catch (err) {
    console.error("Create folder failed:", err);
    res.status(500).json({ message: "Failed to create folder" });
  }
});

app.delete("/api/folders/:id", auth, async (req, res) => {
  try {
    const folder = await Folder.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!folder) return res.status(404).json({ message: "Folder not found" });
    await folder.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("Delete folder failed:", err);
    res.status(500).json({ message: "Failed to delete folder" });
  }
});

/* ===== Check-in interval ===== */
app.post("/api/checkin/interval", auth, async (req, res) => {
  try {
    const { interval } = req.body;
    const days = parseInt(interval, 10);

    if (!days || days < 1 || days > 365) {
      return res.status(400).json({ message: "Interval must be between 1 and 365 days" });
    }

    await User.update(
      { checkinInterval: days, lastCheckinAt: new Date() },
      { where: { id: req.user.id } }
    );

    res.json({ success: true, checkinInterval: days });
  } catch (err) {
    console.error("Save checkin interval failed:", err);
    res.status(500).json({ message: "Failed to save check-in interval" });
  }
});

app.get("/api/checkin/interval", auth, async (req, res) => {
  try {
    const user = await User.findOne({
      where: { id: req.user.id },
      attributes: ["checkinInterval", "lastCheckinAt"],
    });
    res.json({
      checkinInterval: user?.checkinInterval || 90,
      lastCheckinAt: user?.lastCheckinAt || null,
    });
  } catch (err) {
    console.error("Get checkin interval failed:", err);
    res.status(500).json({ message: "Failed to get check-in interval" });
  }
});

/* ===== Nominees CRUD ===== */

// GET /api/nominees — list all nominees for the logged-in user
app.get("/api/nominees", auth, async (req, res) => {
  try {
    const nominees = await Nominee.findAll({
      where: { userId: req.user.id },
      order: [["createdAt", "ASC"]],
    });
    res.json({ success: true, nominees });
  } catch (err) {
    console.error("Fetch nominees failed:", err);
    res.status(500).json({ message: "Failed to fetch nominees" });
  }
});

/* ===== Nominee Access (time-limited link) ===== */
const SECRET = process.env.JWT_SECRET || "supersecret";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const CLIENT_URL = (process.env.CLIENT_URL || "").replace(/\/$/, "");

// Owner triggers an access email to a nominee (protected)
app.post("/api/nominee-access/send/:nomineeId", auth, async (req, res) => {
  try {
    const nomineeId = req.params.nomineeId;
    const nominee = await Nominee.findOne({ where: { id: nomineeId, userId: req.user.id } });
    if (!nominee) return res.status(404).json({ message: "Nominee not found" });

    // gather allowed files
    let files = [];
    if (nominee.accessLevel === "full") {
      files = await FileRecord.findAll({ where: { userId: req.user.id }, attributes: ["id"] });
    } else {
      files = await FileRecord.findAll({ where: { userId: req.user.id, category: nominee.allowedFolders }, attributes: ["id"] });
    }

    const fileIds = files.map(f => f.id);

    const token = jwt.sign({ type: "nominee_access", ownerId: req.user.id, nomineeId: nominee.id, fileIds }, SECRET, { expiresIn: req.body.expiresIn || "14d" });

    const link = `${CLIENT_URL}/nominee-access?token=${token}`;

    if (resend) {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: nominee.email,
        subject: "Access to vault files",
        html: `<p>You were granted temporary access to files. Click <a href="${link}">here</a> to view and download.</p>`,
      });
    } else {
      console.log("Nominee access link (no RESEND):", link);
    }

    res.json({ success: true, link });
  } catch (err) {
    console.error("Send nominee access failed:", err);
    res.status(500).json({ message: "Failed to send nominee access" });
  }
});

// GET /api/nominee-access/status/:nomineeId — check if nominee has opened their link (TEST HELPER)
app.get("/api/nominee-access/status/:nomineeId", auth, async (req, res) => {
  try {
    const nominee = await Nominee.findOne({ where: { id: req.params.nomineeId, userId: req.user.id } });
    if (!nominee) return res.status(404).json({ message: "Nominee not found" });

    const log = await AccessLog.findOne({
      where: { actorEmail: nominee.email, action: "NOMINEE_LINK_REDEEM" },
      order: [["timestamp", "DESC"]],
    });

    res.json({
      success: true,
      opened: !!log,
      openedAt: log ? log.timestamp : null,
      nomineeEmail: nominee.email,
    });
  } catch (err) {
    console.error("Nominee status check failed:", err);
    res.status(500).json({ message: "Failed to check nominee status" });
  }
});

// Public: redeem token and list allowed files
app.get("/api/nominee-access", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ message: "token required" });

    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    if (payload.type !== "nominee_access") return res.status(400).json({ message: "Invalid token type" });

    const owner = await User.findOne({ where: { id: payload.ownerId } });
    if (!owner) return res.status(404).json({ message: "Owner not found" });

    // Prevent access if owner logged back in after token issuance
    if (owner.loginAt) {
      const loginIat = Math.floor(new Date(owner.loginAt).getTime() / 1000);
      if (payload.iat && loginIat > payload.iat) {
        return res.status(403).json({ message: "Owner has returned; access revoked" });
      }
    }

    // fetch files
    let files = [];
    if (Array.isArray(payload.fileIds) && payload.fileIds.length > 0) {
      files = await FileRecord.findAll({ where: { id: payload.fileIds }, attributes: ["id", "filename", "cid", "mimeType", "uploadedAt"] });
    } else {
      // fallback: return no files
      files = [];
    }

    const nominee = await Nominee.findOne({ where: { id: payload.nomineeId } });

    await AccessLog.create({ actorEmail: nominee ? nominee.email : null, role: "nominee", action: "NOMINEE_LINK_REDEEM", fileId: null, ipAddress: req.ip, note: `Redeemed token for owner ${payload.ownerId}` });

    res.json({ success: true, files });
  } catch (err) {
    console.error("Nominee access list failed:", err);
    res.status(500).json({ message: "Failed to process nominee access" });
  }
});

// Public: download a specific file via token
app.get("/api/nominee-access/:fileId", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ message: "token required" });

    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    if (payload.type !== "nominee_access") return res.status(400).json({ message: "Invalid token type" });

    const fileId = parseInt(req.params.fileId, 10);
    if (!Array.isArray(payload.fileIds) || !payload.fileIds.includes(fileId)) {
      return res.status(403).json({ message: "Not authorized for this file" });
    }

    const file = await FileRecord.findOne({ where: { id: fileId, userId: payload.ownerId } });
    if (!file) return res.status(404).json({ message: "File not found" });

    // Prevent access if owner logged back in after token issuance
    const owner = await User.findOne({ where: { id: payload.ownerId } });
    if (owner && owner.loginAt) {
      const loginIat = Math.floor(new Date(owner.loginAt).getTime() / 1000);
      if (payload.iat && loginIat > payload.iat) {
        return res.status(403).json({ message: "Owner has returned; access revoked" });
      }
    }

    // Fetch encrypted content from IPFS and decrypt using stored key
    const chunks = [];
    for await (const chunk of ipfs.cat(file.cid)) {
      chunks.push(chunk);
    }
    const encryptedBuffer = Buffer.concat(chunks);

    const key = Buffer.from(file.encryptionKey, "base64");
    const iv = Buffer.from(file.iv, "hex");
    const authTag = Buffer.from(file.authTag, "hex");

    const decryptedBuffer = decrypt(encryptedBuffer, key, iv, authTag);

    const nominee = await Nominee.findOne({ where: { id: payload.nomineeId } });
    await AccessLog.create({ actorEmail: nominee ? nominee.email : null, role: "nominee", action: "DOWNLOAD_FILE", fileId: file.id, ipAddress: req.ip, note: null });

    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(decryptedBuffer);

  } catch (err) {
    console.error("Nominee download failed:", err);
    res.status(500).json({ message: "Failed to download file" });
  }
});

// POST /api/nominees — create a new nominee
app.post("/api/nominees", auth, async (req, res) => {
  try {
    const { name, email, phone, relationship, accessLevel, allowedFolders } = req.body;

    if (!name || !email) {
      return res.status(400).json({ message: "Name and email are required" });
    }

    const level = accessLevel === "partial" ? "partial" : "full";

    const nominee = await Nominee.create({
      userId: req.user.id,
      name,
      email,
      phone: phone || null,
      relationship: relationship || null,
      accessLevel: level,
      allowedFolders: level === "partial" ? (allowedFolders || []) : [],
    });

    res.status(201).json({ success: true, nominee });
  } catch (err) {
    console.error("Create nominee failed:", err);
    res.status(500).json({ message: "Failed to create nominee" });
  }
});

// PUT /api/nominees/:id — update a nominee (access level, allowed folders, etc.)
app.put("/api/nominees/:id", auth, async (req, res) => {
  try {
    const nominee = await Nominee.findOne({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!nominee) {
      return res.status(404).json({ message: "Nominee not found" });
    }

    const { name, email, phone, relationship, accessLevel, allowedFolders } = req.body;

    if (name !== undefined) nominee.name = name;
    if (email !== undefined) nominee.email = email;
    if (phone !== undefined) nominee.phone = phone;
    if (relationship !== undefined) nominee.relationship = relationship;
    if (accessLevel !== undefined) {
      nominee.accessLevel = accessLevel === "partial" ? "partial" : "full";
      nominee.allowedFolders =
        nominee.accessLevel === "partial" ? (allowedFolders || nominee.allowedFolders || []) : [];
    } else if (allowedFolders !== undefined) {
      nominee.allowedFolders = allowedFolders;
    }

    await nominee.save();
    res.json({ success: true, nominee });
  } catch (err) {
    console.error("Update nominee failed:", err);
    res.status(500).json({ message: "Failed to update nominee" });
  }
});

// DELETE /api/nominees/:id — remove a nominee
app.delete("/api/nominees/:id", auth, async (req, res) => {
  try {
    const nominee = await Nominee.findOne({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!nominee) {
      return res.status(404).json({ message: "Nominee not found" });
    }

    await nominee.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("Delete nominee failed:", err);
    res.status(500).json({ message: "Failed to delete nominee" });
  }
});

/* ===== AI Chat Route ===== */
app.post("/api/ai/chat", auth, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Call OpenAI API
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "You are ShadowVault AI assistant. You help users with digital vault security, legal documents, risk analysis, and audit logs.",
          },
          {
            role: "user",
            content: message,
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: "AI request failed" });
    }

    const aiText = data.choices[0].message.content;

    res.json({
      success: true,
      response: aiText,
    });

  } catch (err) {
    console.error("AI chat failed:", err);
    res.status(500).json({ error: "AI chat failed" });
  }
});

/* ===== AI Risk Analysis ===== */
app.post("/api/ai/risk-analysis", auth, async (req, res) => {
  try {
    const vaultData = req.body;

    const prompt = `
You are a digital vault security analyst.

Analyze the vault security risk based on the data below.

Return:
- Risk Score (0-100)
- Risk Level (Low / Medium / High)
- Issues Found
- Recommendations

Vault Data:
${JSON.stringify(vaultData, null, 2)}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "You are a cybersecurity and digital vault risk analysis expert.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    const data = await response.json();

    res.json({
      success: true,
      analysis: data.choices[0].message.content,
    });

  } catch (err) {
    console.error("Risk analysis failed:", err);
    res.status(500).json({ error: "Risk analysis failed" });
  }
});
/* ===== AI Audit Log Analysis ===== */
app.post("/api/ai/audit-analysis", auth, async (req, res) => {
  try {
    const { logs } = req.body;

    if (!logs) {
      return res.status(400).json({ error: "Logs required" });
    }

    const prompt = `
You are a cybersecurity audit analyst.

Analyze the audit logs below and identify:
- Suspicious activity
- Unusual login locations
- Multiple failed logins
- Unusual file access
- Security risks

Return:
- Risk Level
- Suspicious Events
- Explanation
- Recommended Actions

Audit Logs:
${JSON.stringify(logs, null, 2)}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "You are a cybersecurity audit log monitoring system.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    const data = await response.json();

    res.json({
      success: true,
      analysis: data.choices[0].message.content,
    });

  } catch (err) {
    console.error("Audit analysis failed:", err);
    res.status(500).json({ error: "Audit analysis failed" });
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
