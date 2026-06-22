import { Router } from "express";
import { auth } from "../auth.js";
import { Nominee } from "../db.js";

const router = Router();

// GET /api/nominees
router.get("/", auth, async (req, res, next) => {
  try {
    const nominees = await Nominee.findAll({
      where: { userId: req.user.id },
      order: [["createdAt", "ASC"]],
    });
    res.json({ success: true, nominees });
  } catch (err) {
    next(err);
  }
});

// POST /api/nominees
router.post("/", auth, async (req, res, next) => {
  try {
    const { name, email, phone, relationship, accessLevel, allowedFolders } = req.body;

    if (!name || !email) return res.status(400).json({ message: "Name and email are required" });

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
    next(err);
  }
});

// PUT /api/nominees/:id
router.put("/:id", auth, async (req, res, next) => {
  try {
    const nominee = await Nominee.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!nominee) return res.status(404).json({ message: "Nominee not found" });

    const { name, email, phone, relationship, accessLevel, allowedFolders } = req.body;

    if (name         !== undefined) nominee.name         = name;
    if (email        !== undefined) nominee.email        = email;
    if (phone        !== undefined) nominee.phone        = phone;
    if (relationship !== undefined) nominee.relationship = relationship;

    if (accessLevel !== undefined) {
      nominee.accessLevel    = accessLevel === "partial" ? "partial" : "full";
      nominee.allowedFolders = nominee.accessLevel === "partial"
        ? (allowedFolders || nominee.allowedFolders || [])
        : [];
    } else if (allowedFolders !== undefined) {
      nominee.allowedFolders = allowedFolders;
    }

    await nominee.save();
    res.json({ success: true, nominee });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/nominees/:id
router.delete("/:id", auth, async (req, res, next) => {
  try {
    const nominee = await Nominee.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!nominee) return res.status(404).json({ message: "Nominee not found" });
    await nominee.destroy();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
