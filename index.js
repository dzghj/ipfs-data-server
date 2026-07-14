import "dotenv/config";
import express from "express";
import cors from "cors";

import { sequelize, NomineeAccessSend, Nominee, User, AccessLog } from "./db.js";
import authRoutes   from "./auth.js";
import fileRoutes   from "./routes/files.js";
import folderRoutes from "./routes/folders.js";
import nomineeRoutes from "./routes/nominees.js";
import checkinRoutes from "./routes/checkin.js";
import planRoutes   from "./routes/plans.js";
import aiRoutes     from "./routes/ai.js";
import { buildHealthPayload, isAuthorizedInternalRequest } from "./monitoring.js";
import { Resend } from "resend";
import { Op } from "sequelize";
import crypto from "crypto";

const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const app  = express();
const PORT = process.env.PORT || 4000;

/* ===== Middleware ===== */
app.use(cors());
app.use(express.json());

/* ===== Routes ===== */
app.use("/api/auth",     authRoutes);
app.use("/api",          fileRoutes);      // /api/upload, /api/myfiles, /api/file/:id/*
app.use("/api/folders",  folderRoutes);
app.use("/api/nominees", nomineeRoutes);
app.use("/api/checkin",  checkinRoutes);
app.use("/api/upgrade",  planRoutes);
app.use("/api/ai",       aiRoutes);

/* ===== Health check ===== */
app.get("/health", async (req, res) => {
  try {
    await sequelize.authenticate();
    res.status(200).json(buildHealthPayload({
      status: "ok",
      db: "connected",
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(503).json(buildHealthPayload({
      status: "error",
      db: "disconnected",
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }));
  }
});

app.post("/api/internal/run-resend-check", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const MAX_SENDS = Number(process.env.MAX_RESEND_ATTEMPTS || 2);
  const RESEND_INTERVAL_HOURS = Number(process.env.RESEND_INTERVAL_HOURS || 24);
  const clientUrl = (process.env.CLIENT_URL || "").replace(/\/$/, "");

  try {
    await sequelize.authenticate();

    const cutoff = new Date(Date.now() - RESEND_INTERVAL_HOURS * 60 * 60 * 1000);

    const pending = await NomineeAccessSend.findAll({
      where: {
        sendCount: { [Op.lt]: MAX_SENDS },
        sentAt: { [Op.lte]: cutoff },
      },
    });

    const results = [];

    for (const send of pending) {
      try {
        const nominee = await Nominee.findByPk(send.nomineeId);
        if (!nominee) {
          results.push({ id: send.id, skipped: true, reason: "nominee_missing" });
          continue;
        }

        // If nominee linked to a user account and that user is verified, skip
        if (nominee.nomineeAccountId) {
          const user = await User.findByPk(nominee.nomineeAccountId);
          if (user && user.isVerified) {
            results.push({ id: send.id, skipped: true, reason: "user_verified" });
            continue;
          }
        }

        // Check access logs for any activity by this nominee email
        const engaged = await AccessLog.count({ where: { actorEmail: nominee.email } });
        if (engaged > 0) {
          results.push({ id: send.id, skipped: true, reason: "already_active" });
          continue;
        }

        // Ensure we have a token to send
        let token = send.token;
        if (!token) {
          token = crypto.randomBytes(32).toString("hex");
        }

        const verifyLink = `${clientUrl}/set-password/${token}`;

        if (resendClient) {
          await resendClient.emails.send({
            from: process.env.RESEND_FROM_EMAIL,
            to: nominee.email,
            subject: "Reminder: you were invited to be a nominee",
            html: `<p>This is a reminder. Set your password <a href="${verifyLink}">here</a></p>`,
          });
        } else {
          console.log("(cron) Skipping send — RESEND_API_KEY not set. Verify link:", verifyLink);
        }

        // Update send record
        send.sendCount = (send.sendCount || 0) + 1;
        send.sentAt = new Date();
        send.token = token;
        await send.save();

        results.push({ id: send.id, resent: true });
      } catch (innerErr) {
        console.error("Error processing send", send.id, innerErr);
        results.push({ id: send.id, error: innerErr.message || String(innerErr) });
      }
    }

    res.status(200).json({ success: true, processed: results.length, details: results });
  } catch (error) {
    console.error("Internal cron job failed:", error);
    res.status(503).json({ success: false, message: "Database unavailable" });
  }
});

/* ===== Central error handler ===== */
app.use((err, req, res, _next) => {
  console.error(`[${req.method} ${req.path}]`, err.message);
  res.status(500).json({ message: err.message || "Internal server error" });
});

/* ===== Boot ===== */
(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to database");

    if (process.env.NODE_ENV !== "production") {
      await sequelize.sync();
      console.log("✅ Models synced (dev)");
    }

    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (err) {
    console.error("❌ Server startup failed:", err);
    process.exit(1);
  }
})();
