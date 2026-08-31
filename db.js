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
    status:    { type: DataTypes.STRING,  allowNull: false, defaultValue: "pending" }, // pending | delivered | done
    decision:  { type: DataTypes.JSONB,   allowNull: true }, // filled by the agent
    outcome:   { type: DataTypes.JSONB,   allowNull: true }, // filled by the agent
    createdAt:   { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    deliveredAt: { type: DataTypes.DATE, allowNull: true },
    processedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "AgentEvents", schema: "public", timestamps: false }
);

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
  } catch (err) {
    console.error("❌ Database connection failed", err);
  }
})();

export default sequelize;
