import { Router } from "express";
import { auth } from "../auth.js";
import { Plan, User } from "../db.js";

const router = Router();

// GET /api/upgrade/options
router.get("/options", auth, async (req, res, next) => {
  try {
    const plans = await Plan.findAll({
      attributes: ["id", "name", "maxFiles", "price"],
      order: [["id", "ASC"]],
    });
    res.json({ plans });
  } catch (err) {
    next(err);
  }
});

// POST /api/upgrade/subscribe
router.post("/subscribe", auth, async (req, res, next) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ message: "Plan ID is required" });

    const plan = await Plan.findOne({ where: { id: planId } });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    // TODO: Stripe payment integration

    await User.update(
      { maxFileNumber: plan.maxFiles, planId: plan.id },
      { where: { id: req.user.id } }
    );

    res.json({ success: true, maxFiles: plan.maxFiles });
  } catch (err) {
    next(err);
  }
});

export default router;
