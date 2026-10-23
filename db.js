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

    // Gates /api/admin/* routes (auth.js's requireAdmin middleware). No UI
    // to manage this yet — flip it directly in Postgres:
    //   UPDATE "Users" SET "isAdmin" = true WHERE email = '...';
    isAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Required at registration going forward (see auth.js's /register) — the
    // destination for login OTP codes (otp.js). Nullable because accounts
    // created before this existed have none; those fall back to email OTP.
    phone: { type: DataTypes.STRING, allowNull: true },

    // Email verification. Stores sha256(rawToken), not the raw token itself —
    // same one-way treatment as passwordHash, since this is only ever
    // compared (auth.js's hashToken()), never recovered. The raw value lives
    // only in the emailed link.
    verifyToken:       { type: DataTypes.STRING, allowNull: true },
    verifyTokenExpiry: { type: DataTypes.BIGINT, allowNull: true },
    isVerified:        { type: DataTypes.BOOLEAN, defaultValue: false },

    // Password reset. Same sha256(rawToken)-only treatment as verifyToken.
    resetToken:       { type: DataTypes.TEXT,   allowNull: true },
    resetTokenExpiry: { type: DataTypes.BIGINT, allowNull: true },

    // Login 2FA (otp.js + auth.js's /login, /login/verify-otp,
    // /login/resend-otp). otpCode is sha256(rawCode) — same one-way
    // treatment as every other token on this model; the raw 6-digit code
    // only ever exists in the SMS/email it was sent in. otpAttempts guards
    // against brute-forcing a 6-digit code within its 2-minute window.
    otpCode:     { type: DataTypes.STRING,  allowNull: true },
    otpExpiry:   { type: DataTypes.BIGINT,  allowNull: true },
    otpChannel:  { type: DataTypes.STRING,  allowNull: true }, // "sms" | "email" | "console"
    otpAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    // Plan
    planId:        { type: DataTypes.INTEGER, allowNull: true },
    maxFileNumber: { type: DataTypes.INTEGER, defaultValue: 5 },

    // AI risk (global vault score)
    riskScore:    { type: DataTypes.INTEGER, allowNull: true },
    riskAnalysis: { type: DataTypes.TEXT,    allowNull: true },

    // Login tracking
    lastLogin: { type: DataTypes.DATE, allowNull: true },
    loginAt:   { type: DataTypes.DATE, allowNull: true },

    // Check-in interval (days). lastCheckinAt resets on every successful
    // login (auth.js's /login/verify-otp) per the product's own stated
    // design (SwitchPage.jsx: "Each successful login resets your check-in
    // timer"). switchTriggeredAt is set by the checkin sweep
    // (index.js's /api/internal/run-checkin-check) the first time it finds
    // this user overdue, so the dead-man's switch fires exactly once per
    // missed period instead of re-granting nominee access on every cron
    // tick; it's cleared back to null on the user's next login, which is
    // what lets the switch re-arm.
    checkinInterval:   { type: DataTypes.INTEGER, defaultValue: 90 },
    lastCheckinAt:     { type: DataTypes.DATE, allowNull: true, defaultValue: Sequelize.NOW },
    switchTriggeredAt: { type: DataTypes.DATE, allowNull: true },

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

    // OpenTimestamps anchor for sha256Hash (see secure-share/anchor.js)
    otsProof:      { type: DataTypes.TEXT, allowNull: true }, // base64 .ots
    otsAnchoredAt: { type: DataTypes.DATE, allowNull: true }, // when we stamped it
    otsUpgradedAt: { type: DataTypes.DATE, allowNull: true }, // when the Bitcoin attestation was attached

    // Encryption
    encryptionKey: { type: DataTypes.TEXT,   allowNull: true },
    // true once encryptionKey is wrapped (AES-256-GCM under FILE_ENCRYPTION_KEY,
    // see secure-share/key-wrap.js) rather than a raw plaintext base64 key —
    // false for files uploaded before envelope encryption existed, or while
    // FILE_ENCRYPTION_KEY isn't set; resolveFileKey() handles both
    // transparently, no backfill needed.
    keyWrapped:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
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
    // sha256(jwt) — stored only as a record of what was sent; nothing looks
    // this column up to grant access (the JWT is verified by signature, see
    // GET /api/nominee-access in index.js), and every resend mints a fresh
    // token rather than re-reading this one, so the raw JWT need not be kept.
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

/* ===== SupportMessages — 24/7 Support chat widget ===== */
// User submits a message from the frontend chat popup; it's enqueued to the
// agent (as an AgentEvent, type "support_message") for Ollama to answer, same
// pull/report path as everything else. The frontend polls this row for the
// reply instead of the raw AgentEvents queue.
export const SupportMessage = sequelize.define(
  "SupportMessage",
  {
    id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId:     { type: DataTypes.INTEGER, allowNull: false },
    message:    { type: DataTypes.TEXT,    allowNull: false },
    status:     { type: DataTypes.STRING,  allowNull: false, defaultValue: "pending" }, // pending | answered | failed
    reply:      { type: DataTypes.TEXT,    allowNull: true },
    agentEventId: { type: DataTypes.INTEGER, allowNull: true },
    createdAt:  { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    answeredAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "SupportMessages", schema: "public", timestamps: false }
);

/* ===== Bootstrap DDL ===== */

// sequelize.sync() is skipped in production, so tables added after the initial
// deploy are created here instead. Idempotent (CREATE ... IF NOT EXISTS / ADD
// COLUMN IF NOT EXISTS) — safe to run on every boot. Mirrors migrations/001..011;
// keep in sync with the FileRecord, NomineeAccessSend, AgentEvent, AgentHeartbeat and
// SupportMessage models above.
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

  CREATE TABLE IF NOT EXISTS public."SupportMessages" (
    id             SERIAL PRIMARY KEY,
    "userId"       INTEGER NOT NULL,
    message        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    reply          TEXT,
    "agentEventId" INTEGER,
    "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "answeredAt"   TIMESTAMP WITH TIME ZONE
  );
  CREATE INDEX IF NOT EXISTS idx_support_messages_user_id
    ON public."SupportMessages" ("userId", "createdAt");

  -- FileRecords is created by sequelize.sync() in dev; prod needs this explicitly.
  ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "otsProof" TEXT;
  ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "otsAnchoredAt" TIMESTAMP WITH TIME ZONE;
  ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "otsUpgradedAt" TIMESTAMP WITH TIME ZONE;
  ALTER TABLE public."FileRecords" ADD COLUMN IF NOT EXISTS "keyWrapped" BOOLEAN NOT NULL DEFAULT false;

  -- Login 2FA (see migrations/010_users_login_otp.sql for the full comment).
  ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
  ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpCode" TEXT;
  ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpExpiry" BIGINT;
  ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpChannel" TEXT;
  ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpAttempts" INTEGER NOT NULL DEFAULT 0;

  -- Plan was previously only ever created by sequelize.sync() (dev-only) —
  -- meaning it likely doesn't exist at all in production. See
  -- migrations/011_plan_tiers.sql for the full comment on the per-folder
  -- file-limit tiers this backs.
  CREATE TABLE IF NOT EXISTS public."Plan" (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    "maxFiles"  INTEGER NOT NULL,
    price       DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );
  -- Defensive: a pre-existing "Plan" table (e.g. from an earlier dev
  -- sequelize.sync()) may have an id column with no auto-increment default,
  -- which makes the INSERT below fail. Attaches one if missing.
  CREATE SEQUENCE IF NOT EXISTS public."Plan_id_seq" OWNED BY public."Plan".id;
  SELECT setval('public."Plan_id_seq"', COALESCE((SELECT MAX(id) FROM public."Plan"), 0) + 1, false);
  ALTER TABLE public."Plan" ALTER COLUMN id SET DEFAULT nextval('public."Plan_id_seq"');
  -- Renamed in place (not deleted/recreated) so any User.planId already
  -- pointing at these rows keeps working — Normal/Middle/Super read as
  -- unprofessional, replaced with Basic/Plus/Premium. Safe to re-run: a
  -- no-op once no row is named 'Normal'/'Middle'/'Super' anymore.
  UPDATE public."Plan" SET name = 'Basic'   WHERE name = 'Normal';
  UPDATE public."Plan" SET name = 'Plus'    WHERE name = 'Middle';
  UPDATE public."Plan" SET name = 'Premium' WHERE name = 'Super';
  INSERT INTO public."Plan" (name, "maxFiles", price) VALUES
    ('Basic', 5, 0),
    ('Plus', 10, 9.99),
    ('Premium', 999999, 19.99)
  ON CONFLICT (name) DO NOTHING;

  -- Dead-man's-switch tracking — see migrations/012_switch_triggered_at.sql.
  ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "switchTriggeredAt" TIMESTAMP WITH TIME ZONE;

  -- See migrations/013_users_is_admin.sql.
  ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false;

  -- Clean up a pre-existing "Free/Pro/Business/Enterprise" tier set (March
  -- 2026) that the Basic/Plus/Premium migration above never actually
  -- touched — its rename-in-place UPDATEs matched 'Normal'/'Middle'/'Super'
  -- rows, not these, so both sets ended up coexisting and /api/upgrade/
  -- options returned all 7 rows to the UI. Re-point any user still on one
  -- of the old rows to Basic FIRST (there is no DB-level foreign key here,
  -- just a plain planId integer, so this must happen before the DELETE
  -- below or those users would keep a dangling reference), using a name
  -- lookup rather than a hardcoded id so this is safe to re-run. All three
  -- steps are no-ops once the old rows are gone.
  UPDATE public."Users" SET "planId" = (SELECT id FROM public."Plan" WHERE name = 'Basic')
    WHERE "planId" IN (SELECT id FROM public."Plan" WHERE name IN ('Free', 'Pro', 'Business', 'Enterprise'));
  DELETE FROM public."Plan" WHERE name IN ('Free', 'Pro', 'Business', 'Enterprise');

  -- Repriced per request: Basic/Plus/Premium $0/$9.99/$19.99 -> $50/$100/$200.
  UPDATE public."Plan" SET price = 50  WHERE name = 'Basic';
  UPDATE public."Plan" SET price = 100 WHERE name = 'Plus';
  UPDATE public."Plan" SET price = 200 WHERE name = 'Premium';

  -- Users.planId defaulted to 1 (the now-deleted old "Free" row's id),
  -- which is how every new signup silently got a free plan with no
  -- payment step. Dropping the default means new rows get NULL instead -
  -- resolveUserPlan() in index.js already falls back to Basic-equivalent
  -- limits for a NULL planId today, so this alone does not yet enforce
  -- "must pay at signup"; it only stops new users from silently landing on
  -- a plan row that no longer exists. Enforcing an actual payment-before-
  -- use gate is a separate change (see conversation) - not done here.
  ALTER TABLE public."Users" ALTER COLUMN "planId" DROP DEFAULT;
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
