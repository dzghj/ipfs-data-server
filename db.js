import { Sequelize, DataTypes } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

/* ===== Sequelize connection ===== */

export const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "postgres",
  protocol: "postgres",
  logging: false,
});

/* ==============================
   SUBSCRIBE / UPGRADE PLAN
================================ */
router.post("/upgrade/subscribe", async (req, res) => {
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
      { maxFileNumber: plan.maxFiles },
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
router.get("/upgrade/options", async (req, res) => {
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



/* ===== Models ===== */

export const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    passwordHash: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    keyholderEmail: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    resetToken: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    resetTokenExpiry: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    verifyToken: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  
    verifyTokenExpiry: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
  
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
   // 📦 MAX FILE LIMIT
   maxFileNumber: {
    type: DataTypes.INTEGER,
    defaultValue: 5,
  },
  // 🤖 AI Vault Risk (GLOBAL)
  riskScore: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  riskAnalysis: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
   planId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

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
  },
  {
    tableName: "Users",
    schema: "public",
    timestamps: false, // 🔴 REQUIRED
  }
);

export const Keyholder = sequelize.define(
  "Keyholder",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    passwordHash: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    assignedUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    canAccessFiles: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    publicKey: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

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
  },
  {
    tableName: "Keyholders",
    schema: "public",
    timestamps: false,
  }
);
export const Plan = sequelize.define(
  "Plan",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    maxFiles: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    price: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },

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
  },
  {
    tableName: "Plans",
    schema: "public",
    timestamps: false,
  }
);



export const FileRecord = sequelize.define(
  "FileRecord",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    filename: { type: DataTypes.STRING, allowNull: false },
    cid: { type: DataTypes.STRING, allowNull: false },
    sha256Hash: { type: DataTypes.STRING, allowNull: true },

    // 🔐 NEW FIELDS FOR ENCRYPTED FILES
    encryptionKey: { type: DataTypes.TEXT, allowNull: true },
    iv: { type: DataTypes.TEXT, allowNull: true },
    authTag: { type: DataTypes.TEXT, allowNull: true },
    mimeType: { type: DataTypes.STRING, allowNull: true },

     // 🛡️ Protection / Dead Man Switch
     protectionOn: { type: DataTypes.BOOLEAN, defaultValue: false },
     remainingDays: { type: DataTypes.INTEGER, allowNull: true },
 
     // 👥 Keyholder emails list
     keyHolderList: { type: DataTypes.JSONB, allowNull: true },

    uploadedAt: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.NOW },
  },
  {
    tableName: "FileRecords",
    schema: "public",
    timestamps: false,
  }
);


export const SharedKey = sequelize.define(
  "SharedKey",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    fileId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    keyholderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    encryptedKey: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

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
  },
  {
    tableName: "SharedKeys",
    schema: "public",
    timestamps: false,
  }
);

export const AccessLog = sequelize.define(
  "AccessLog",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    actorEmail: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    role: {
      type: DataTypes.STRING,
    },

    action: {
      type: DataTypes.STRING,
    },

    fileId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    timestamp: {
      type: DataTypes.DATE,
      defaultValue: Sequelize.NOW,
    },

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
  },
  {
    tableName: "AccessLogs",
    schema: "public",
    timestamps: false,
  }
);

/* ===== Init ===== */

(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to database");

    // 🚫 Do NOT use alter:true on Render prod DB
   // await sequelize.sync();
if (process.env.NODE_ENV !== "production") {
  await sequelize.sync();
}
    console.log("✅ Models synced");
  } catch (err) {
    console.error("❌ Database connection failed", err);
  }
})();

export default sequelize;
