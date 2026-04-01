import cors from "cors";
import bodyParser from "body-parser";
import express from "express";
import multer from "multer";
import dotenv from "dotenv";

import authRoutes, { auth } from "./auth.js";
import { sequelize, FileRecord,User,Plan } from "./db.js";
import { secureUpload,secureView } from "./secure-share/index.js";



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
      attributes: ["id", "filename", "cid", "uploadedAt","protectionOn"]
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
      { maxFileNumber: plan.maxFiles,
        planId: plan.id },
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
