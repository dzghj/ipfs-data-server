import { Router } from "express";
import { auth } from "../auth.js";
import { Folder } from "../db.js";

const router = Router();

// GET /api/folders
router.get("/", auth, async (req, res, next) => {
  try {
    const folders = await Folder.findAll({
      where: { userId: req.user.id },
      order: [["createdAt", "ASC"]],
      attributes: ["id", "name", "createdAt"],
    });
    res.json({ success: true, folders });
  } catch (err) {
    next(err);
  }
});

// POST /api/folders
router.post("/", auth, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Folder name required" });

    const existing = await Folder.findOne({ where: { userId: req.user.id, name } });
    if (existing) return res.status(409).json({ message: `"${name}" folder already exists` });

    const folder = await Folder.create({ userId: req.user.id, name });
    res.status(201).json({ success: true, folder });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/folders/:id
router.delete("/:id", auth, async (req, res, next) => {
  try {
    const folder = await Folder.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!folder) return res.status(404).json({ message: "Folder not found" });
    await folder.destroy();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
