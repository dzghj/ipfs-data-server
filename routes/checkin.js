import { Router } from "express";
import { auth } from "../auth.js";
import { User } from "../db.js";

const router = Router();

// GET /api/checkin/interval
router.get("/interval", auth, async (req, res, next) => {
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
    next(err);
  }
});

// POST /api/checkin/interval
router.post("/interval", auth, async (req, res, next) => {
  try {
    const days = parseInt(req.body.interval, 10);
    if (!days || days < 1 || days > 365) {
      return res.status(400).json({ message: "Interval must be between 1 and 365 days" });
    }

    await User.update(
      { checkinInterval: days, lastCheckinAt: new Date() },
      { where: { id: req.user.id } }
    );

    res.json({ success: true, checkinInterval: days });
  } catch (err) {
    next(err);
  }
});

export default router;
