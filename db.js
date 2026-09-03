import { Sequelize, DataTypes } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

/* ===== Connection ===== */

export const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "postgres",
  protocol: "postgres",
  logging: false,
});

/* ===== Users ===== */

export const User = sequelize.define(
  "User",
  {
    id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email:          { type: DataTypes.STRING,  allowNull: false, unique: true },
    passwordHash:   { type: DataTypes.STRING,  allowNull: true },

    // Email verification
    verifyToken:       { type: DataTypes.STRING, allowNull: true },
    verifyTokenExpiry: { type: DataTypes.BIGINT, allowNull: true },
    isVerified:        { type: DataTypes.BOOLEAN, defaultValue: false },

    // Password reset
    resetToken:       { type: DataTypes.TEXT,   allowNull: true },
    resetTokenExpiry: { type: DataTypes.BIGINT, allowNull: true },

    // Plan
    planId:        { type: DataTypes.INTEGER, allowNull: true },
    maxFileNumber: { type: DataTypes.INTEGER, defaultValue: 5 },

    // AI risk (global vault score)
    riskScore:    { type: DataTypes.INTEGER, allowNull: true },
    riskAnalysis: { type: DataTypes.TEXT,    allowNull: true },

    // Login tracking
    lastLogin: { type: DataTypes.DATE, allowNull: true },
    loginAt:   { type: DataTypes.DATE, allowNull: true },

    // Check-in interval (days)
    checkinInterval: { type: DataTypes.INTEGER, defaultValue: 90 },
    lastCheckinAt:   { type: DataTypes.DATE, allowNull: true, defaultValue: Sequelize.NOW },

    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
  },
  { tableName: "Users", schema: "public", timestamps: false }
);

/* ===== Plans ===== */

export const Plan = sequelize.define(
  "Plan",
  {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name:      { type: DataTypes.STRING,  allowNull: false, unique: true },
    maxFiles:  { type: DataTypes.INTEGER, allowNull: false },
    price:     { type: DataTypes.FLOAT,   allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
  },
  { tableName: "Plan", schema: "public", timestamps: false }
);

/* ===== FileRecords ===== */

export const FileRecord = sequelize.define(
  "FileRecord",
  {
    id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId:   { type: DataTypes.INTEGER, allowNull: false },
    filename: { type: DataTypes.STRING,  allowNull: false },
    cid:      { type: DataTypes.STRING,  allowNull: false },
    sha256Hash: { type: DataTypes.STRING, allowNull: true },

    // Encryption
    encryptionKey: { type: DataTypes.TEXT,   allowNull: true },
    iv:            { type: DataTypes.TEXT,   allowNull: true },
    authTag:       { type: DataTypes.TEXT,   allowNull: true },
    mimeType:      { type: DataTypes.STRING, allowNull: true },
    category:      { type: DataTypes.STRING, allowNull: true, defaultValue: "Personal" },

    // Protection
    protectionOn: { type: DataTypes.BOOLEAN, defaultValue: false },

    // Nominee email list (legacy — kept for backward compat)
    keyHolderList: { type: DataTypes.JSONB, allowNull: true },

    uploadedAt: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "FileRecords", schema: "public", timestamps: false }
);

/* ===== AccessLogs ===== */

export const AccessLog = sequelize.define(
  "AccessLog",
  {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    actorEmail:  { type: DataTypes.STRING,  allowNull: true },
    role:        { type: DataTypes.STRING },
    action:      { type: DataTypes.STRING },
    fileId:      { type: DataTypes.INTEGER, allowNull: true },
    ipAddress:   { type: DataTypes.STRING,  allowNull: true },
    note:        { type: DataTypes.TEXT,    allowNull: true },
    timestamp:   { type: DataTypes.DATE,    defaultValue: Sequelize.NOW },
  },
  { tableName: "AccessLogs", schema: "public", timestamps: false }
);

/* ===== Folders ===== */

export const Folder = sequelize.define(
  "Folder",
  {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId:    { type: DataTypes.INTEGER, allowNull: false },
    name:      { type: DataTypes.STRING,  allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
  },
  { tableName: "Folders", schema: "public", timestamps: false }
);

/* ===== Nominees ===== */

export const Nominee = sequelize.define(
  "Nominee",
  {
    id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId:       { type: DataTypes.INTEGER, allowNull: false },
    name:         { type: DataTypes.STRING,  allowNull: false },
    email:        { type: DataTypes.STRING,  allowNull: false },
    phone:        { type: DataTypes.STRING,  allowNull: true },
    relationship: { type: DataTypes.STRING,  allowNull: true },
    accessLevel:  { type: DataTypes.STRING,  allowNull: false, defaultValue: "full" },
    allowedFolders: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
    createdAt:    { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    updatedAt:    { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
  },
  { tableName: "Nominees", schema: "public", timestamps: false }
);

/* ===== NomineeAccessSends — tracks every link sent + resend state ===== */

export const NomineeAccessSend = sequelize.define(
  "NomineeAccessSend",
  {
    id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nomineeId:   { type: DataTypes.INTEGER, allowNull: false },
    ownerId:     { type: DataTypes.INTEGER, allowNull: false },
    token:       { type: DataTypes.TEXT,    allowNull: false },
    sendCount:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }, // 1 = initial, 2 = first resend, 3 = second resend
    lastSentAt:  { type: DataTypes.DATE,    allowNull: false, defaultValue: Sequelize.NOW },
    openedAt:    { type: DataTypes.DATE,    allowNull: true  }, // filled when nominee redeems
    createdAt:   { type: DataTypes.DATE,    allowNull: false, defaultValue: Sequelize.NOW },
  },
  { tableName: "NomineeAccessSends", schema: "public", timestamps: false }
);

/* ===== AgentEvents — queue of events for the ipfs-AI-control agent to pull ===== */

export const AgentEvent = sequelize.define(
  "AgentEvent",
  {
    id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    source:    { type: DataTypes.STRING,  allowNull: false }, // "github" | "backend"
    type:      { type: DataTypes.STRING,  allowNull: true  }, // workflow name or event type
    payload:   { type: DataTypes.JSONB,   allowNull: false },
    // pending  → enqueued, not yet pulled
    // delivered→ leased to the agent, in-flight
    // done     → agent reported back, action succeeded
    // failed   → agent reported back, but decision was null or outcome.success === false
    // dead     → pulled AGENT_MAX_ATTEMPTS times without an ack (poison pill), given up
    status:    { type: DataTypes.STRING,  allowNull: false, defaultValue: "pending" },
    attempts:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // hand-out count
    lastError: { type: DataTypes.TEXT,    allowNull: true }, // short reason for failed/dead
    decision:  { type: DataTypes.JSONB,   allowNull: true }, // filled by the agent
    outcome:   { type: DataTypes.JSONB,   allowNull: true }, // filled by the agent
    createdAt:   { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    deliveredAt: { type: DataTypes.DATE, allowNull: true },
    processedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "AgentEvents", schema: "public", timestamps: false }
);

/* ===== AgentHeartbeat — last-seen + Ollama status pushed by ipfs-AI-control ===== */

// The agent (Mac Mini, Tailscale-only) can't be probed from GitHub's runners, so
// instead it POSTs a heartbeat here every HEARTBEAT_INTERVAL_MS. The
// ai-health-check workflow reads GET /api/internal/agent/heartbeat and alerts if
// the row is stale. One row, keyed by name.
export const AgentHeartbeat = sequelize.define(
  "AgentHeartbeat",
  {
    name:         { type: DataTypes.STRING, primaryKey: true }, // "ipfs-ai-control"
    ollamaStatus: { type: DataTypes.STRING, allowNull: true },  // "up" | "down" | "no_model"
    ollamaModel:  { type: DataTypes.STRING, allowNull: true },
    detail:       { type: DataTypes.JSONB,  allowNull: true },
    lastSeenAt:   { type: DataTypes.DATE,   allowNull: false, defaultValue: Sequelize.NOW },
  },
  { tableName: "AgentHeartbeats", schema: "public", timestamps: false }
);

/* ===== Bootstrap DDL ===== */

// sequelize.sync() is skipped in production, so tables added after the initial
// deploy are created here instead. Idempotent (CREATE ... IF NOT EXISTS / ADD
// COLUMN IF NOT EXISTS) — safe to run on every boot. Mirrors migrations/001..004;
// keep in sync with the NomineeAccessSend, AgentEvent and AgentHeartbeat models above.
const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS public."NomineeAccessSends" (
    id           SERIAL PRIMARY KEY,
    "nomineeId"  INTEGER NOT NULL,
    "ownerId"    INTEGER NOT NULL,
    token        TEXT NOT NULL,
    "sendCount"  INTEGER NOT NULL DEFAULT 1,
    "lastSentAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "openedAt"   TIMESTAMP WITH TIME ZONE,
    "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_nominee_access_sends_nominee_id
    ON public."NomineeAccessSends" ("nomineeId");
  CREATE INDEX IF NOT EXISTS idx_nominee_access_sends_send_count
    ON public."NomineeAccessSends" ("sendCount", "lastSentAt");

  CREATE TABLE IF NOT EXISTS public."AgentEvents" (
    id            SERIAL PRIMARY KEY,
    source        TEXT NOT NULL,
    type          TEXT,
    payload       JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    "lastError"   TEXT,
    decision      JSONB,
    outcome       JSONB,
    "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "deliveredAt" TIMESTAMP WITH TIME ZONE,
    "processedAt" TIMESTAMP WITH TIME ZONE
  );
  -- Added after 002 shipped — CREATE TABLE IF NOT EXISTS won't backfill columns.
  ALTER TABLE public."AgentEvents" ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE public."AgentEvents" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
  CREATE INDEX IF NOT EXISTS idx_agent_events_status_created
    ON public."AgentEvents" (status, "createdAt");

  CREATE TABLE IF NOT EXISTS public."AgentHeartbeats" (
    name           TEXT PRIMARY KEY,
    "ollamaStatus" TEXT,
    "ollamaModel"  TEXT,
    detail         JSONB,
    "lastSeenAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );
`;

/* ===== Init ===== */

(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to database");
    if (process.env.NODE_ENV !== "production") {
      await sequelize.sync();
      console.log("✅ Models synced (dev)");
    } else {
      console.log("🚫 Skipping sequelize.sync() in production");
    }
    await sequelize.query(BOOTSTRAP_SQL);
    console.log("✅ Bootstrap tables ensured (NomineeAccessSends, AgentEvents, AgentHeartbeats)");
  } catch (err) {
    console.error("❌ Database connection failed", err);
  }
})();

export default sequelize;
