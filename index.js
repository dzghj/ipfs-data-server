import cors from "cors";
import bodyParser from "body-parser";
import express from "express";
import multer from "multer";
import dotenv from "dotenv";

import authRoutes, { auth, requireAdmin } from "./auth.js";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { renderEmail } from "./otp.js";
import { createOrder as createPaypalOrder, captureOrder as capturePaypalOrder } from "./paypal.js";
import { sequelize, FileRecord, User, Plan, Nominee, Folder, AccessLog, NomineeAccessSend, AgentEvent, AgentHeartbeat, SupportMessage } from "./db.js";
import { Op } from "sequelize";
import { secureUploadClientEncrypted, secureView, unpinCid } from "./secure-share/index.js";
import { resolveFileKey } from "./secure-share/key-wrap.js";
import { upgradeProof, verifyProof } from "./secure-share/anchor.js";
import { ipfs } from "./secure-share/ipfs-client.js";
import { decrypt, sha256 } from "./secure-share/crypto-utils.js";
import { buildHealthPayload, isAuthorizedInternalRequest } from "./monitoring.js";
import { notifyAgent, enqueueGithubEvent } from "./notifyAgent.js";
import { uploadLimiter } from "./rateLimiters.js";
import crypto from "crypto";



dotenv.config();

// CLIENT_URL is baked into every verify/reset/nominee-access link this app
// ever emails out. A real incident: it was once set to a specific Vercel
// *preview* deployment URL (one with a per-build hash in the hostname, e.g.
// secure-ipfs-frontend-<hash>-<team>.vercel.app) — those get garbage
// collected per Vercel's retention policy, so every link silently went
// dead once that one build was cleaned up, independent of the token's own
// 24h expiry. This can't catch every bad value, but it catches the exact
// class of mistake that already happened once: any raw PaaS-assigned
// preview/deploy hostname, instead of a real stable domain.
(function checkClientUrl() {
  const raw = process.env.CLIENT_URL;
  if (!raw) {
    console.warn("⚠️  CLIENT_URL is not set — every verify/reset/nominee-access link will be malformed.");
    return;
  }
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    console.warn(`⚠️  CLIENT_URL is not a valid URL: "${raw}"`);
    return;
  }
  const previewHostPatterns = [
    /^[a-z0-9-]+-[a-z0-9]{8,}-[a-z0-9-]+\.vercel\.app$/i, // project-<hash>-team.vercel.app
    /--[a-z0-9-]+\.netlify\.app$/i,                        // branch--site.netlify.app
  ];
  if (previewHostPatterns.some((re) => re.test(host))) {
    console.warn(
      `⚠️  CLIENT_URL ("${raw}") looks like a one-off preview deployment URL, not a stable domain — ` +
      `this is exactly the mistake that previously made every emailed link go dead once that build was ` +
      `garbage-collected. Point this at your real custom domain or a stable production alias instead.`
    );
  }
})();

const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const app = express();

// Explicit allowlist instead of cors()'s wide-open default (which reflects
// any origin). Requests with no Origin header (server-to-server calls from
// the Mac Mini agent, GitHub Actions, curl, Render's own cron) are left
// alone — this only restricts browser-originated cross-site requests.
const corsAllowlist = [process.env.CLIENT_URL, "http://localhost:3000"]
  .filter(Boolean)
  .map((u) => u.replace(/\/$/, ""));
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsAllowlist.includes(origin.replace(/\/$/, ""))) {
      return callback(null, true);
    }
    callback(new Error("Not allowed by CORS"));
  },
}));
app.use(bodyParser.json());

// This is a pure JSON API with per-user authenticated data — nothing here
// should ever be cached or 304'd by a browser/proxy (Express's default ETag
// behavior treats identical-content responses as cacheable, which is wrong
// for private, per-request data and just adds a confusing failure mode).
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.disable("etag");

/* ===== Multer Memory ===== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

/* ===== Plan tiers (per-folder file limits) =====
   Basic/Plus/Premium are seeded by migrations/011_plan_tiers.sql. "Premium"'s
   maxFiles is a large sentinel (not a real cap) rather than NULL, so every
   comparison site can use one plain number check instead of null-handling
   throughout — UNLIMITED_FILES is how call sites recognize it for display
   ("Unlimited" instead of the literal number). */
const UNLIMITED_FILES = 999999;

async function resolveUserPlan(user) {
  if (user.planId) {
    const plan = await Plan.findByPk(user.planId);
    if (plan) return { planName: plan.name, maxFilesPerFolder: plan.maxFiles };
  }
  // No plan assigned yet (never upgraded) — matches the Basic tier's
  // values, which are also User.maxFileNumber's column default.
  return { planName: "Basic", maxFilesPerFolder: user.maxFileNumber ?? 5 };
}

/* ===== Routes ===== */
app.use("/api/auth", authRoutes);

console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("DATABASE_URL loaded:", !!process.env.DATABASE_URL);
/* ===== health check ===== */
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

/* ===== ipfs-AI-control agent event queue ===== */
// The agent runs on the Mac Mini (Tailscale-only, no public inbound), so it
// pulls instead of being pushed to. GitHub Actions workflows and this server
// enqueue events here; the agent polls GET /api/internal/agent/events, analyses
// each with Ollama, and reports back to POST .../events/:id/result.
//
// Redelivery: an event handed out but not acked within AGENT_LEASE_MS is
// offered again, so a crashed agent never loses events — but only up to
// AGENT_MAX_ATTEMPTS hand-outs, after which it's marked "dead" (poison pill)
// instead of looping forever.
const AGENT_LEASE_MS = Number(process.env.AGENT_LEASE_MS || 5 * 60 * 1000);
const AGENT_MAX_ATTEMPTS = Number(process.env.AGENT_MAX_ATTEMPTS || 5);

app.post("/api/internal/github-event", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const result = await enqueueGithubEvent(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Failed to enqueue GitHub event:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Agent pulls pending events (and stale delivered ones), marking them delivered.
app.get("/api/internal/agent/events", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const staleCutoff = new Date(Date.now() - AGENT_LEASE_MS);

  try {
    // Reap poison events first: leased, lease expired, and already handed out
    // AGENT_MAX_ATTEMPTS times without an ack. Stop re-offering them.
    await AgentEvent.update(
      {
        status: "dead",
        lastError: `no result after ${AGENT_MAX_ATTEMPTS} delivery attempts`,
        processedAt: new Date(),
      },
      {
        where: {
          status: "delivered",
          deliveredAt: { [Op.lt]: staleCutoff },
          attempts: { [Op.gte]: AGENT_MAX_ATTEMPTS },
        },
      }
    );

    const where = {
      [Op.or]: [
        { status: "pending" },
        {
          status: "delivered",
          deliveredAt: { [Op.lt]: staleCutoff },
          attempts: { [Op.lt]: AGENT_MAX_ATTEMPTS },
        },
      ],
    };
    // Optional ?type= / ?excludeType= — lets the agent run a separate, faster
    // poll loop just for support_message events without the infra loop racing
    // it for the same rows (excludeType keeps infra events out of that race).
    if (req.query.type) where.type = req.query.type;
    if (req.query.excludeType) where.type = { [Op.or]: [{ [Op.ne]: req.query.excludeType }, { [Op.is]: null }] };

    const rows = await AgentEvent.findAll({
      where,
      order: [["createdAt", "ASC"]],
      limit,
    });

    const now = new Date();
    await Promise.all(
      rows.map((r) =>
        r.update({ status: "delivered", deliveredAt: now, attempts: r.attempts + 1 })
      )
    );

    res.json({
      events: rows.map((r) => ({
        id: r.id,
        source: r.source,
        type: r.type,
        payload: r.payload,
        attempts: r.attempts,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error("Agent event pull failed:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// Agent reports its decision + outcome for one event.
app.post("/api/internal/agent/events/:id/result", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const row = await AgentEvent.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: "Unknown event" });

    const decision = req.body?.decision ?? null;
    const outcome = req.body?.outcome ?? null;
    // The agent posts a result even when the brain threw or the action failed
    // (decision null / outcome.success === false) — record that as "failed", not "done".
    const failed = decision === null || outcome?.success === false;

    await row.update({
      status: failed ? "failed" : "done",
      decision,
      outcome,
      lastError: failed
        ? String(outcome?.message ?? "agent reported failure").slice(0, 500)
        : null,
      processedAt: new Date(),
    });

    // Support-chat events resolve into their SupportMessages row instead of
    // just sitting in the queue — that's what the frontend chat widget polls.
    if (row.type === "support_message" && row.payload?.supportMessageId) {
      const reply = outcome?.reply ?? decision?.reply ?? null;
      await SupportMessage.update(
        {
          status: failed || !reply ? "failed" : "answered",
          reply: reply || "Sorry, something went wrong answering your question. Please try again.",
          agentEventId: row.id,
          answeredAt: new Date(),
        },
        { where: { id: row.payload.supportMessageId } }
      ).catch((err) => console.warn("[SUPPORT] failed to update SupportMessage:", err.message));
    }

    res.json({ success: true, status: failed ? "failed" : "done" });
  } catch (err) {
    console.error("Agent result update failed:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// Queue health at a glance — counts by status + oldest unfinished event.
app.get("/api/internal/agent/events/stats", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const rows = await AgentEvent.findAll({
      attributes: [
        "status",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
        [sequelize.fn("MIN", sequelize.col("createdAt")), "oldest"],
      ],
      group: ["status"],
    });

    const byStatus = {};
    for (const r of rows) {
      byStatus[r.get("status")] = {
        count: Number(r.get("count")),
        oldest: r.get("oldest"),
      };
    }
    const backlog = (byStatus.pending?.count || 0) + (byStatus.delivered?.count || 0);
    res.json({ byStatus, backlog, needsAttention: (byStatus.failed?.count || 0) + (byStatus.dead?.count || 0) });
  } catch (err) {
    console.error("Agent event stats failed:", err.message);
    res.status(500).json({ message: err.message });
  }
});

/* ===== 24/7 Support chat ===== */
// User submits a question from the frontend chat popup. It's stored here and
// enqueued to the agent as an AgentEvent (type "support_message"); the agent
// runs it through Ollama with a support-assistant prompt and reports back via
// the normal POST .../events/:id/result path, which resolves this row (see
// above). The frontend polls GET /api/support/message/:id for the reply.
const SUPPORT_MESSAGE_MAX_LEN = 2000;

app.post("/api/support/message", auth, async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ message: "Message is required" });
    if (message.length > SUPPORT_MESSAGE_MAX_LEN) {
      return res.status(400).json({ message: `Message too long (max ${SUPPORT_MESSAGE_MAX_LEN} chars)` });
    }

    const support = await SupportMessage.create({
      userId: req.user.id,
      message,
      status: "pending",
    });

    const event = await AgentEvent.create({
      source: "backend",
      type: "support_message",
      payload: { type: "support_message", supportMessageId: support.id, userId: req.user.id, message },
      status: "pending",
    });

    await support.update({ agentEventId: event.id });

    res.json({ success: true, id: support.id, status: support.status });
  } catch (err) {
    console.error("Support message submit failed:", err.message);
    res.status(500).json({ message: "Failed to submit message" });
  }
});

// Frontend polls this every few seconds until status is answered/failed.
app.get("/api/support/message/:id", auth, async (req, res) => {
  try {
    const support = await SupportMessage.findByPk(req.params.id);
    if (!support || support.userId !== req.user.id) {
      return res.status(404).json({ message: "Not found" });
    }
    res.json({
      id: support.id,
      status: support.status,
      reply: support.reply,
      createdAt: support.createdAt,
      answeredAt: support.answeredAt,
    });
  } catch (err) {
    console.error("Support message fetch failed:", err.message);
    res.status(500).json({ message: err.message });
  }
});

/* ===== ipfs-AI-control agent heartbeat ===== */
// The agent is Tailscale-only, so GitHub's runners can't probe it directly.
// Instead it POSTs here every HEARTBEAT_INTERVAL_MS with its Ollama status, and
// the ai-health-check workflow reads GET .../heartbeat and alerts if it's stale.
const AGENT_NAME = "ipfs-ai-control";
const AGENT_HEARTBEAT_STALE_MS = Number(process.env.AGENT_HEARTBEAT_STALE_MS || 10 * 60 * 1000);

app.post("/api/internal/agent/heartbeat", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const now = new Date();
    await AgentHeartbeat.upsert({
      name: AGENT_NAME,
      ollamaStatus: req.body?.ollama ?? null,
      ollamaModel: req.body?.model ?? null,
      detail: req.body?.detail ?? null,
      lastSeenAt: now,
    });
    res.json({ success: true, lastSeenAt: now.toISOString() });
  } catch (err) {
    console.error("Agent heartbeat update failed:", err.message);
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/internal/agent/heartbeat", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const row = await AgentHeartbeat.findByPk(AGENT_NAME);
    if (!row) {
      return res.json({ present: false, agent: "UNKNOWN", ollama: null });
    }
    const ageMs = Date.now() - new Date(row.lastSeenAt).getTime();
    const stale = ageMs > AGENT_HEARTBEAT_STALE_MS;
    res.json({
      present: true,
      agent: stale ? "DOWN" : "UP",
      stale,
      ageSeconds: Math.round(ageMs / 1000),
      staleThresholdSeconds: Math.round(AGENT_HEARTBEAT_STALE_MS / 1000),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      ollama: { status: row.ollamaStatus, model: row.ollamaModel },
      detail: row.detail ?? null,
    });
  } catch (err) {
    console.error("Agent heartbeat read failed:", err.message);
    res.status(500).json({ message: err.message });
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
        lastSentAt: { [Op.lte]: cutoff },
      },
    });

    const results = [];

    for (const sendRecord of pending) {
      try {
        const nominee = await Nominee.findByPk(sendRecord.nomineeId);
        if (!nominee) {
          results.push({ id: sendRecord.id, skipped: true, reason: "nominee_missing" });
          continue;
        }

        if (nominee.nomineeAccountId) {
          const user = await User.findByPk(nominee.nomineeAccountId);
          if (user && user.isVerified) {
            results.push({ id: sendRecord.id, skipped: true, reason: "user_verified" });
            continue;
          }
        }

        const engaged = await AccessLog.count({ where: { actorEmail: nominee.email } });
        if (engaged > 0) {
          results.push({ id: sendRecord.id, skipped: true, reason: "already_active" });
          continue;
        }

        let token = sendRecord.token;
        if (!token) {
          token = crypto.randomBytes(32).toString("hex");
        }

        const verifyLink = `${clientUrl}/set-password/${token}`;

        if (resendClient) {
          // Resend returns { data, error } on failure rather than throwing —
          // throw explicitly so this lands in the per-record catch below
          // instead of silently marking a failed send as sent (sendCount/
          // lastSentAt/token would advance past a reminder that never went
          // out, and the real failure would never surface in `results`).
          const emailResponse = await resendClient.emails.send({
            from: process.env.RESEND_FROM_EMAIL,
            to: nominee.email,
            subject: "Reminder: you were invited to be a nominee",
            html: `<p>This is a reminder. Set your password <a href="${verifyLink}">here</a></p>`,
          });
          if (emailResponse.error) throw new Error(emailResponse.error.message || "Resend send failed");
        } else {
          console.log("(cron) Skipping resend — RESEND_API_KEY not set. Verify link:", verifyLink);
        }

        sendRecord.sendCount = (sendRecord.sendCount || 0) + 1;
        sendRecord.lastSentAt = new Date();
        sendRecord.token = token;
        await sendRecord.save();

        results.push({ id: sendRecord.id, resent: true });
      } catch (innerErr) {
        console.error("Error processing send", sendRecord.id, innerErr);
        results.push({ id: sendRecord.id, error: innerErr.message || String(innerErr) });
      }
    }

    res.status(200).json({ success: true, processed: results.length, details: results });
  } catch (error) {
    console.error("Internal cron job failed:", error);
    res.status(503).json({ success: false, message: "Database unavailable" });
  }
});

/* ===== Upload Route ===== */
app.post("/api/upload", auth, uploadLimiter, upload.single("file"), async (req, res) => {
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

    // Client-side encryption is mandatory, not opt-in — this used to fall
    // back to secureUpload() (server generates and sees the key) whenever a
    // caller omitted clientEncrypted, which meant any client that forgot
    // the flag — an old cached frontend build, a direct API call — silently
    // got the weaker, server-sees-plaintext path. The real app
    // (src/utils/crypto.js's buildEncryptedUpload) always sets this, so
    // enforcing it here costs the live app nothing.
    const clientEncrypted = req.body.clientEncrypted === "1" || req.body.clientEncrypted === "true";
    if (!clientEncrypted) {
      return res.status(400).json({
        message: "Uploads must be encrypted client-side before sending — this server never generates or sees your file's encryption key. If you're using the official app, please refresh and try again.",
      });
    }

    // Client-side encrypted uploads arrive as application/octet-stream ciphertext
    // (see the frontend's src/utils/crypto.js), so validate the caller-declared
    // original type/name instead of multer's detected ones.
    const declaredMime = req.body.mimeType;
    const declaredName = req.body.originalName || req.file.originalname;

    if (!allowedMimeTypes.includes(declaredMime)) {
      return res.status(400).json({ message: "Unsupported file type" });
    }

    // Optional: sanitize filename
    const safeFilename = String(declaredName || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const category = req.body.category || "Personal";

    // Per-folder file limit, gated by plan tier — checked before any
    // encryption/IPFS work so a rejected upload fails fast.
    const user = await User.findByPk(req.user.id);
    const { planName, maxFilesPerFolder } = await resolveUserPlan(user);
    if (maxFilesPerFolder < UNLIMITED_FILES) {
      const existingInFolder = await FileRecord.count({ where: { userId: req.user.id, category } });
      if (existingInFolder >= maxFilesPerFolder) {
        return res.status(403).json({
          message: `Your ${planName} plan allows up to ${maxFilesPerFolder} files in "${category}" — you've reached that limit. Upgrade your plan or choose a different folder.`,
          planName,
          maxFilesPerFolder,
          category,
        });
      }
    }

    const result = await secureUploadClientEncrypted({
      encryptedBuffer: req.file.buffer,
      encKey: req.body.encKey,
      encIv: req.body.encIv,
      encAuthTag: req.body.encAuthTag,
      plaintextSha256: req.body.plaintextSha256,
      filename: safeFilename,
      ownerId: req.user.id,
      mimeType: declaredMime,
    });

    const record = await FileRecord.create({
      userId: req.user.id,
      filename: safeFilename,
      cid: result.cid,
      sha256Hash: result.sha256Hash,
      otsProof: result.otsProof,
      otsAnchoredAt: result.otsAnchoredAt,
      encryptionKey: result.encryptedFileKey,
      keyWrapped: result.keyWrapped,
      iv: result.iv, // hex string    
      authTag: result.authTag, // hex string   
      mimeType: declaredMime,
      category,
      uploadedAt: new Date(),
    });

    notifyAgent({ type: "file_upload", userId: req.user.id, cid: result.cid, size: req.file.size });

    res.json({
      success: true,
      file: {
        id: record.id,
        filename: record.filename,
        cid: record.cid,
        sha256Hash: record.sha256Hash,
        otsAnchoredAt: record.otsAnchoredAt
      }
    });

  } catch (err) {
    console.error("Upload failed:", err);
    notifyAgent({ type: "error", route: "/api/upload", message: err.message });
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

/* ===== OpenTimestamps proof ===== */
// The .ots proof anchors this file's SHA-256 into Bitcoin via OpenTimestamps.
// Anyone can verify it against Bitcoin without trusting this server — that is
// what makes the file's timestamp independently verifiable. See
// secure-share/anchor.js. Proofs start as a calendar commitment and gain a
// Bitcoin attestation after a few hours; these routes upgrade lazily on access.

async function assertFileAccess(fileId, user) {
  const file = await FileRecord.findByPk(fileId);
  if (!file) { const e = new Error("File not found"); e.status = 404; throw e; }
  if (user.id === file.userId) return file;
  const nominee = await Nominee.findOne({
    where: { userId: file.userId, nomineeAccountId: user.id },
  });
  if (!nominee) { const e = new Error("Not authorized"); e.status = 403; throw e; }
  if (
    nominee.accessLevel === "partial" &&
    !(nominee.allowedFolders || []).includes(file.category)
  ) { const e = new Error("Not authorized"); e.status = 403; throw e; }
  return file;
}

async function maybeUpgradeProof(file) {
  if (!file.otsProof || file.otsUpgradedAt) return file;
  const next = await upgradeProof(file.otsProof);
  if (next && next !== file.otsProof) {
    await file.update({ otsProof: next, otsUpgradedAt: new Date() });
  }
  return file;
}

// Download the raw .ots proof file (verify it with `ots verify`, or the endpoint below).
app.get("/api/file/:id/proof", auth, async (req, res) => {
  try {
    let file = await assertFileAccess(req.params.id, req.user);
    if (!file.otsProof) return res.status(404).json({ message: "No timestamp proof for this file" });
    file = await maybeUpgradeProof(file);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${(file.filename || "file").replace(/"/g, "")}.ots"`
    );
    res.send(Buffer.from(file.otsProof, "base64"));
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

// Verify the proof against Bitcoin and return the confirmed timestamp (if any).
app.get("/api/file/:id/proof/verify", auth, async (req, res) => {
  try {
    let file = await assertFileAccess(req.params.id, req.user);
    if (!file.otsProof) return res.status(404).json({ message: "No timestamp proof for this file" });
    file = await maybeUpgradeProof(file);
    const result = await verifyProof(file.otsProof, file.sha256Hash);
    res.json({
      fileId: file.id,
      cid: file.cid,
      sha256Hash: file.sha256Hash,
      otsAnchoredAt: file.otsAnchoredAt,
      otsUpgradedAt: file.otsUpgradedAt,
      ...result,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

// Batch-upgrade calendar-only proofs to Bitcoin attestations. Point a cron here.
app.post("/api/internal/ots/upgrade-pending", async (req, res) => {
  if (!isAuthorizedInternalRequest(req, process.env.INTERNAL_API_SECRET)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const pending = await FileRecord.findAll({
      where: { otsProof: { [Op.ne]: null }, otsUpgradedAt: null },
      limit: Math.min(Number(req.query.limit) || 100, 500),
    });
    let upgraded = 0;
    for (const f of pending) {
      const next = await upgradeProof(f.otsProof);
      if (next && next !== f.otsProof) {
        await f.update({ otsProof: next, otsUpgradedAt: new Date() });
        upgraded++;
      }
    }
    res.json({ success: true, checked: pending.length, upgraded });
  } catch (err) {
    res.status(500).json({ message: err.message });
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

/* ===== Delete File =====
   Removes the FileRecord row (and its encryption key) and unpins the CID
   from this node and the whole cluster — see secure-share/index.js's
   unpinCid(). Destroying the key alone already makes the ciphertext
   permanently unrecoverable, but leaving it pinned forever was never
   intentional, just unimplemented; actually dropping the pin matters for
   backups (an old DB backup predating this delete could still have the key)
   and for not silently growing cluster storage forever.
   Two different FileRecords could in principle share a CID (same ciphertext
   bytes uploaded twice) even though each upload uses a fresh random key, so
   this checks for any other live reference before actually unpinning —
   never unpin out from under a file that's still supposed to exist. */
app.delete("/api/file/:id", auth, async (req, res) => {
  try {
    const file = await FileRecord.findOne({
      where: { id: req.params.id, userId: req.user.id }, // security: only owner can delete
    });

    if (!file) {
      return res.status(404).json({ message: "File not found" });
    }

    const { cid } = file;

    await AccessLog.create({
      actorEmail: req.user.email || null,
      role: "User",
      action: "DELETE_FILE",
      fileId: file.id,
      ipAddress: req.ip,
      note: file.filename,
    });

    await file.destroy();

    const stillReferenced = await FileRecord.count({ where: { cid } });
    if (stillReferenced === 0) {
      await unpinCid(cid);
    } else {
      console.log(`Skipping unpin for ${cid} — still referenced by ${stillReferenced} other FileRecord(s)`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete file failed:", err);
    res.status(500).json({ message: "Failed to delete file" });
  }
});

/* ===== My Files ===== */
app.get("/api/myfiles", auth, async (req, res) => {
  try {
    const files = await FileRecord.findAll({
      where: { userId: req.user.id },
      order: [["uploadedAt", "DESC"]],
      attributes: ["id", "filename", "cid", "sha256Hash", "otsAnchoredAt", "otsUpgradedAt", "uploadedAt", "protectionOn", "keyHolderList", "category", "mimeType"]
    });

    // Live plan lookup (not just whatever was cached in localStorage at
    // login) — this is the one place the vault page always re-fetches on
    // load, so it's the right spot to keep the displayed tier/limit honest
    // after an upgrade.
    const user = await User.findByPk(req.user.id);
    const { planName, maxFilesPerFolder } = await resolveUserPlan(user);

    res.json({
      success: true,
      files,
      plan: {
        name: planName,
        maxFilesPerFolder,
        unlimited: maxFilesPerFolder >= UNLIMITED_FILES,
      },
    });
  } catch (err) {
    console.error("Fetch files failed:", err);
    res.status(500).json({ message: "Failed to fetch files" });
  }
});
/* ==============================
   SUBSCRIBE / UPGRADE PLAN
================================ */
// Only ever grants a FREE plan directly — this used to grant any plan with
// no payment collected at all (a real "POST any planId, get Premium for
// free" exploit). Paid plans now have to go through the PayPal
// create-order/capture-order pair below, which only grants a plan after
// PayPal itself confirms a completed capture for it.
app.post("/api/upgrade/subscribe", auth, async (req, res) => {
  try {
    const { planId } = req.body;
    const userId = req.user.id;

    if (!planId) {
      return res.status(400).json({ message: "Plan ID is required" });
    }

    const plan = await Plan.findOne({ where: { id: planId } });
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    if (plan.price > 0) {
      return res.status(400).json({
        message: "This plan requires payment — use /api/upgrade/create-order to start checkout.",
      });
    }

    await User.update(
      { maxFileNumber: plan.maxFiles, planId: plan.id },
      { where: { id: userId } }
    );

    res.json({ success: true, maxFiles: plan.maxFiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Subscription failed" });
  }
});

// Step 1 of paid checkout: create a PayPal order for the plan's real price
// (server-decided, never trusts a client-supplied amount) and hand back
// just the order id for the frontend's PayPal Buttons to approve.
app.post("/api/upgrade/create-order", auth, async (req, res) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ message: "Plan ID is required" });

    const plan = await Plan.findOne({ where: { id: planId } });
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    if (!(plan.price > 0)) {
      return res.status(400).json({ message: "This plan doesn't require payment — use /api/upgrade/subscribe." });
    }

    const order = await createPaypalOrder({
      amount: plan.price,
      customId: `${req.user.id}:${plan.id}`,
    });

    res.json({ orderId: order.id });
  } catch (err) {
    console.error("PayPal create-order failed:", err);
    res.status(500).json({ message: "Failed to start checkout", error: err.message });
  }
});

// Step 2: the frontend calls this once the buyer approves the order in the
// PayPal popup. custom_id is read back from PAYPAL'S OWN capture response,
// not from anything the client sends here — that's what makes this safe
// against a client claiming "I paid for Basic but want Premium" to apply.
app.post("/api/upgrade/capture-order", auth, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ message: "orderId is required" });

    const capture = await capturePaypalOrder(orderId);
    if (capture.status !== "COMPLETED") {
      return res.status(402).json({ message: `Payment not completed (status: ${capture.status})` });
    }

    const customId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id
      || capture.purchase_units?.[0]?.custom_id;
    const [customUserId, customPlanId] = String(customId || "").split(":");

    if (Number(customUserId) !== req.user.id) {
      return res.status(403).json({ message: "This order was not created by the current user" });
    }

    const plan = await Plan.findOne({ where: { id: Number(customPlanId) } });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    await User.update(
      { maxFileNumber: plan.maxFiles, planId: plan.id },
      { where: { id: req.user.id } }
    );

    res.json({ success: true, maxFiles: plan.maxFiles });
  } catch (err) {
    console.error("PayPal capture-order failed:", err);
    res.status(500).json({ message: "Failed to complete checkout", error: err.message });
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
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "internal-dev-secret";

// Shared by the owner-initiated manual send route and the automatic
// checkin-sweep trigger below — mints a fresh nominee-access token, emails
// it, and records the send. Throws on a hard email failure (caller decides
// how to handle that: the manual route surfaces it to the owner, the sweep
// logs it and moves on to the next nominee rather than aborting the batch).
async function grantNomineeAccess(owner, nominee, { expiresIn = "14d" } = {}) {
  let files = [];
  if (nominee.accessLevel === "full") {
    files = await FileRecord.findAll({ where: { userId: owner.id }, attributes: ["id"] });
  } else {
    files = await FileRecord.findAll({ where: { userId: owner.id, category: nominee.allowedFolders }, attributes: ["id"] });
  }

  const fileIds = files.map(f => f.id);
  const token = jwt.sign({ type: "nominee_access", ownerId: owner.id, nomineeId: nominee.id, fileIds }, SECRET, { expiresIn });
  const link = `${CLIENT_URL}/nominee-access?token=${token}`;

  if (resend) {
    // Resend returns { data, error } on failure rather than throwing —
    // check explicitly, or a failed send still falls through to
    // NomineeAccessSend.create() below and records a "sent" entry for an
    // email the nominee never received.
    const emailResponse = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: nominee.email,
      subject: "You've been granted vault access",
      html: renderEmail({
        heading: "You've been granted vault access",
        bodyHtml: `
          <p style="margin:0 0 12px;">Hi ${nominee.name || "there"},</p>
          <p style="margin:0 0 12px;">${owner.email} has designated you as a trusted nominee on ShadowVault and granted you access to
          ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} stored in their vault.</p>
          <p style="margin:0;">Use the button below to view and download the shared files. This link is personal to you, time-limited, and should be treated like a password — don't forward it.</p>
        `,
        button: { label: "View Shared Files", href: link },
      }),
    });
    if (emailResponse.error) {
      throw new Error(emailResponse.error.message || "Resend send failed");
    }
  } else {
    console.log("Nominee access link (no RESEND):", link);
  }

  // Record this send so the resend scheduler can track it. The JWT itself
  // is a usable bearer credential (jwt.verify() checks it by signature, not
  // by DB lookup — nothing ever reads this column back to rebuild a link,
  // every resend mints a fresh one), so only its hash is stored.
  await NomineeAccessSend.create({
    nomineeId:  nominee.id,
    ownerId:    owner.id,
    token:      sha256(token),
    sendCount:  1,
    lastSentAt: new Date(),
  });

  return { link };
}

// Owner triggers an access email to a nominee (protected)
app.post("/api/nominee-access/send/:nomineeId", auth, async (req, res) => {
  try {
    const nomineeId = req.params.nomineeId;
    const nominee = await Nominee.findOne({ where: { id: nomineeId, userId: req.user.id } });
    if (!nominee) return res.status(404).json({ message: "Nominee not found" });

    const { link } = await grantNomineeAccess(req.user, nominee, { expiresIn: req.body.expiresIn || "14d" });
    res.json({ success: true, link });
  } catch (err) {
    console.error("Send nominee access failed:", err);
    res.status(500).json({ message: "Failed to send nominee access", error: err.message });
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

    // The nominee row must still exist with the SAME userId the token was
    // issued for — a 14-day-old token otherwise stays a usable credential
    // even after the owner deletes that nominee entirely. accessLevel/
    // allowedFolders are read fresh below too (not from the token's baked-in
    // fileIds), so a downgrade from full to partial access — or removing a
    // folder — takes effect on the nominee's very next request, not just on
    // their next freshly-sent link.
    const nominee = await Nominee.findOne({ where: { id: payload.nomineeId, userId: payload.ownerId } });
    if (!nominee) return res.status(403).json({ message: "Access has been revoked" });

    let files = [];
    if (nominee.accessLevel === "full") {
      files = await FileRecord.findAll({ where: { userId: payload.ownerId }, attributes: ["id", "filename", "cid", "mimeType", "uploadedAt"] });
    } else {
      files = await FileRecord.findAll({ where: { userId: payload.ownerId, category: nominee.allowedFolders }, attributes: ["id", "filename", "cid", "mimeType", "uploadedAt"] });
    }

    await AccessLog.create({ actorEmail: nominee.email, role: "nominee", action: "NOMINEE_LINK_REDEEM", fileId: null, ipAddress: req.ip, note: `Redeemed token for owner ${payload.ownerId}` });

    // Mark the send record as opened
    await NomineeAccessSend.update(
      { openedAt: new Date() },
      { where: { nomineeId: payload.nomineeId, openedAt: null } }
    );

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

    // Same live re-check as the list route above: the nominee row must
    // still exist for this owner, and its CURRENT accessLevel/allowedFolders
    // gate the file — not payload.fileIds, which is a snapshot frozen at
    // the moment the link was issued and would otherwise keep authorizing a
    // deleted or downgraded nominee for the token's full 14-day life.
    const nominee = await Nominee.findOne({ where: { id: payload.nomineeId, userId: payload.ownerId } });
    if (!nominee) return res.status(403).json({ message: "Access has been revoked" });

    const fileId = parseInt(req.params.fileId, 10);
    const file = await FileRecord.findOne({ where: { id: fileId, userId: payload.ownerId } });
    if (!file) return res.status(404).json({ message: "File not found" });

    if (nominee.accessLevel !== "full" && !nominee.allowedFolders?.includes(file.category)) {
      return res.status(403).json({ message: "Not authorized for this file" });
    }

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

    const key = resolveFileKey(file);
    const iv = Buffer.from(file.iv, "hex");
    const authTag = Buffer.from(file.authTag, "hex");

    const decryptedBuffer = decrypt(encryptedBuffer, key, iv, authTag);

    await AccessLog.create({ actorEmail: nominee.email, role: "nominee", action: "DOWNLOAD_FILE", fileId: file.id, ipAddress: req.ip, note: null });

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
/* ===== Health Check ===== */
app.get("/api/health", async (req, res) => {
  // Require internal secret so this endpoint isn't publicly accessible
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    await sequelize.authenticate();
    res.json({
      status: "ok",
      db: "connected",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      db: "disconnected",
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/* ===== Internal: Unopened Link Resend Check (called by external scheduler) =====
   Protected by x-internal-secret header. Own path, deliberately distinct
   from /api/internal/run-resend-check above (that one handles unverified-
   registration invite reminders — a different NomineeAccessSend use of the
   same table; the two used to collide on the same path, which silently
   made this logic dead code since Express only ever dispatches to the
   first-registered handler for a given path).
   Finds all NomineeAccessSend records where:
     - openedAt is null (nominee never opened the link)
     - sendCount < 3 (haven't already resent twice)
     - lastSentAt was more than RESEND_INTERVAL_HOURS ago
   Then resends the email and increments sendCount. Covers links sent both
   by the owner's manual "send access" button and by the checkin sweep
   below.
================================================================= */
app.post("/api/internal/run-link-resend-check", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const RESEND_INTERVAL_HOURS = parseFloat(process.env.RESEND_INTERVAL_HOURS || "24");
  const cutoff = new Date(Date.now() - RESEND_INTERVAL_HOURS * 60 * 60 * 1000);

  try {
    // Find sends that are unopened, not maxed out, and old enough to resend
    const pendingResends = await NomineeAccessSend.findAll({
      where: {
        openedAt:  null,
        sendCount: { [Op.lt]: 3 },
        lastSentAt: { [Op.lt]: cutoff },
      },
    });

    const results = [];

    for (const record of pendingResends) {
      const nominee = await Nominee.findOne({ where: { id: record.nomineeId } });
      if (!nominee) continue;

      // Generate a fresh token (keeps expiry rolling)
      const fileRecords = nominee.accessLevel === "full"
        ? await FileRecord.findAll({ where: { userId: record.ownerId }, attributes: ["id"] })
        : await FileRecord.findAll({ where: { userId: record.ownerId, category: nominee.allowedFolders }, attributes: ["id"] });

      const fileIds = fileRecords.map(f => f.id);
      const newToken = jwt.sign(
        { type: "nominee_access", ownerId: record.ownerId, nomineeId: nominee.id, fileIds },
        SECRET,
        { expiresIn: "14d" }
      );
      const link = `${CLIENT_URL}/nominee-access?token=${newToken}`;

      // Send the email. Resend returns { data, error } on failure rather
      // than throwing — checked explicitly and, on failure, this record is
      // skipped (not marked sent) so the next cron run actually retries it,
      // instead of silently burning through all 3 attempts on sends that
      // never went out. One failure also must not abort the whole batch —
      // this is per-record, unlike the route's single outer try/catch.
      if (resend) {
        try {
          const emailResponse = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL,
            to: nominee.email,
            subject: `Reminder: You have vault access waiting (${record.sendCount + 1} of 3)`,
            html: renderEmail({
              heading: "Your vault access is still waiting",
              bodyHtml: `
                <p style="margin:0 0 12px;">Hi ${nominee.name},</p>
                <p style="margin:0 0 12px;">This is a reminder that you've been granted access to files in a ShadowVault vault, but the link hasn't been opened yet.</p>
                <p style="margin:0;">This is reminder ${record.sendCount + 1} of 3. If you don't need this access, you can safely ignore this email.</p>
              `,
              button: { label: "View Shared Files", href: link },
            }),
          });
          if (emailResponse.error) throw new Error(emailResponse.error.message || "Resend send failed");
        } catch (sendErr) {
          console.error(`[LINK RESEND CHECK] Send failed for ${nominee.email}:`, sendErr.message);
          results.push({ nomineeId: nominee.id, email: nominee.email, error: sendErr.message });
          continue;
        }
      } else {
        console.log(`[LINK RESEND CHECK] No RESEND configured. Link for ${nominee.email}:`, link);
      }

      // Update the record (hash only — see the create() site above)
      await record.update({
        sendCount:  record.sendCount + 1,
        lastSentAt: new Date(),
        token:      sha256(newToken),
      });

      results.push({
        nomineeId:  nominee.id,
        email:      nominee.email,
        sendCount:  record.sendCount + 1,
      });
    }

    console.log(`[LINK RESEND CHECK] Processed ${results.length} resend(s) at ${new Date().toISOString()}`);
    res.json({ success: true, resent: results.length, details: results });
  } catch (err) {
    console.error("Link resend check failed:", err);
    res.status(500).json({ message: "Link resend check failed", error: err.message });
  }
});

/* ===== Internal: Continuity Check-In Sweep (called by external scheduler) =====
   This is the actual dead-man's switch — previously nothing anywhere ever
   compared checkinInterval/lastCheckinAt to "now", so nominee access only
   ever happened via the owner's manual "send access" button. This finds
   every user who is overdue (now - lastCheckinAt > checkinInterval days)
   and hasn't already been triggered for the current overdue period
   (switchTriggeredAt is null), auto-grants their nominees access via the
   same grantNomineeAccess() the manual route uses, then sets
   switchTriggeredAt so it fires exactly once per missed period instead of
   re-sending on every run. A user re-arms the switch simply by logging in
   again (auth.js clears switchTriggeredAt there).
================================================================= */
app.post("/api/internal/run-checkin-check", async (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!isAuthorizedInternalRequest(req, internalSecret)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const candidates = await User.findAll({ where: { switchTriggeredAt: null } });

    const overdue = candidates.filter((user) => {
      if (!user.lastCheckinAt) return false;
      const intervalMs = (user.checkinInterval || 90) * 24 * 60 * 60 * 1000;
      return Date.now() - new Date(user.lastCheckinAt).getTime() > intervalMs;
    });

    const results = [];

    for (const user of overdue) {
      const nominees = await Nominee.findAll({ where: { userId: user.id } });

      let notified = 0;
      for (const nominee of nominees) {
        try {
          await grantNomineeAccess(user, nominee);
          notified++;
        } catch (err) {
          // One nominee's email failing (bad address, Resend hiccup)
          // shouldn't stop the rest of this user's nominees, or the rest
          // of the overdue batch — this is the only time a real missed
          // check-in grants access, so it needs to keep trying everyone.
          console.error(`[CHECKIN SWEEP] Failed to notify nominee ${nominee.id} for user ${user.id}:`, err.message);
        }
      }

      // Mark triggered even if there were zero nominees or every send
      // failed — this prevents retrying the same user every single run;
      // the existing resend-check cron already handles re-sending
      // individual unopened links once a grant has gone out.
      await user.update({ switchTriggeredAt: new Date() });
      results.push({ userId: user.id, nomineesTotal: nominees.length, nomineesNotified: notified });
    }

    console.log(`[CHECKIN SWEEP] ${overdue.length} user(s) newly overdue at ${new Date().toISOString()}`);
    res.json({ success: true, usersTriggered: overdue.length, details: results });
  } catch (err) {
    console.error("Checkin sweep failed:", err);
    res.status(500).json({ message: "Checkin sweep failed", error: err.message });
  }
});

/* ===== Admin ===== */
// Didn't exist at all before this — the frontend's /admin page was calling
// this exact path already, 404ing silently with no feedback. isAdmin is
// re-checked fresh per request by requireAdmin (auth.js), not trusted from
// the JWT.
app.get("/api/admin/files", auth, requireAdmin, async (req, res) => {
  try {
    const files = await FileRecord.findAll({
      attributes: ["userId", "filename", "cid", "uploadedAt"],
      order: [["userId", "ASC"], ["uploadedAt", "DESC"]],
    });

    const byUser = new Map();
    for (const f of files) {
      if (!byUser.has(f.userId)) byUser.set(f.userId, []);
      byUser.get(f.userId).push({ fileName: f.filename, cid: f.cid, uploadedAt: f.uploadedAt });
    }

    res.json(Array.from(byUser, ([userId, files]) => ({ userId, files })));
  } catch (err) {
    console.error("Admin files fetch failed:", err);
    res.status(500).json({ message: "Failed to fetch admin files" });
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
