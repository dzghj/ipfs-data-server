import "dotenv/config";
import express from "express";
import cors from "cors";

import { sequelize } from "./db.js";
import authRoutes   from "./auth.js";
import fileRoutes   from "./routes/files.js";
import folderRoutes from "./routes/folders.js";
import nomineeRoutes from "./routes/nominees.js";
import checkinRoutes from "./routes/checkin.js";
import planRoutes   from "./routes/plans.js";
import aiRoutes     from "./routes/ai.js";

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
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), env: process.env.NODE_ENV });
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
