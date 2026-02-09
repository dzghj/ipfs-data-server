import { Sequelize, DataTypes } from "sequelize";
import dotenv from "dotenv";
dotenv.config();

export const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "postgres",
  protocol: "postgres",
  logging: false,
});

/* ===== Common timestamp fields ===== */
const timestamps = {
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW,
  },
};

/* ===== Models ===== */

export const User = sequelize.define(
  "User",
  {
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING, allowNull: false },
    keyholderEmail: { type: DataTypes.STRING, allowNull: true },
    resetToken: { type: DataTypes.TEXT, allowNull: true },
    resetTokenExpiry: { type: DataTypes.BIGINT, allowNull: true },
    ...timestamps,
  },
  { tableName: "Users", schema: "public", timestamps: true }
);

export const Keyholder = sequelize.define(
  "Keyholder",
  {
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING, allowNull: true },
    assignedUserId: { type: DataTypes.INTEGER, allowNull: true },
    canAccessFiles: { type: DataTypes.BOOLEAN, defaultValue: true },
    publicKey: { type: DataTypes.TEXT, allowNull: true },
    ...timestamps,
  },
  { tableName: "Keyholders", schema: "public", timestamps: true }
);

export const FileRecord = sequelize.define(
  "FileRecord",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },
    filename: { type: DataTypes.STRING, allowNull: false },
    cid: { type: DataTypes.STRING, allowNull: false },
    sha256Hash: { type: DataTypes.STRING, allowNull: true },
    encryptionKey: { type: DataTypes.TEXT, allowNull: true },
    uploadedAt: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
    ...timestamps,
  },
  { tableName: "FileRecords", schema: "public", timestamps: true }
);

export const SharedKey = sequelize.define(
  "SharedKey",
  {
    fileId: { type: DataTypes.INTEGER, allowNull: false },
    keyholderId: { type: DataTypes.INTEGER, allowNull: false },
    encryptedKey: { type: DataTypes.TEXT, allowNull: false },
    ...timestamps,
  },
  { tableName: "SharedKeys", schema: "public", timestamps: true }
);

export const AccessLog = sequelize.define(
  "AccessLog",
  {
    actorEmail: { type: DataTypes.STRING, allowNull: true },
    role: { type: DataTypes.STRING },
    action: { type: DataTypes.STRING },
    fileId: { type: DataTypes.INTEGER, allowNull: true },
    ipAddress: { type: DataTypes.STRING, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    timestamp: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
    ...timestamps,
  },
  { tableName: "AccessLogs", schema: "public", timestamps: true }
);

/* ===== Init ===== */
(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to database");

    // OK for now — remove later in production
   // await sequelize.sync({ alter: true });

    console.log("✅ Models synced");
  } catch (err) {
    console.error("❌ Database connection failed", err);
  }
})();

export default sequelize;
