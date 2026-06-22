import { Router } from "express";
import { auth } from "../auth.js";
import { Nominee, User } from "../db.js";
import crypto from "crypto";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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

    // Option A: Invite-as-account — create or reuse a User for the nominee and send set-password link
    let nomineeAccountId = null;

    // Check for existing user record
    let existingUser = await User.findOne({ where: { email } });

    const clientUrl = (process.env.CLIENT_URL || "").replace(/\/$/, "");

    if (existingUser) {
      // If already verified, reuse account
      if (existingUser.isVerified) {
        nomineeAccountId = existingUser.id;
      } else {
        // regenerate verification token and resend set-password link
        const verifyToken = crypto.randomBytes(32).toString("hex");
        const verifyTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
        existingUser.verifyToken = verifyToken;
        existingUser.verifyTokenExpiry = verifyTokenExpiry;
        await existingUser.save();

        const verifyLink = `${clientUrl}/set-password/${verifyToken}`;
        if (resend) {
          await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL,
            to: email,
            subject: "You were invited to be a nominee",
            html: `<p>You were invited to access a vault. Set your password <a href="${verifyLink}">here</a></p>`,
          });
        } else {
          console.log("Skipping nominee invite email (RESEND_API_KEY not set). Verify link:", verifyLink);
        }
        nomineeAccountId = existingUser.id;
      }
    } else {
      // create a user invite (no password yet)
      const verifyToken = crypto.randomBytes(32).toString("hex");
      const verifyTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;

      const created = await User.create({
        email,
        verifyToken,
        verifyTokenExpiry,
        isVerified: false,
      });

      const verifyLink = `${clientUrl}/set-password/${verifyToken}`;

      if (resend) {
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL,
          to: email,
          subject: "You were invited to be a nominee",
          html: `<p>You were invited to access a vault. Set your password <a href="${verifyLink}">here</a></p>`,
        });
      } else {
        console.log("Skipping nominee invite email (RESEND_API_KEY not set). Verify link:", verifyLink);
      }

      nomineeAccountId = created.id;
    }

    const level = accessLevel === "partial" ? "partial" : "full";
    const nominee = await Nominee.create({
      userId: req.user.id,
      name,
      email,
      phone: phone || null,
      relationship: relationship || null,
      accessLevel: level,
      allowedFolders: level === "partial" ? (allowedFolders || []) : [],
      nomineeAccountId,
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

// POST /api/nominees/:id/public-key  (nominee sets their public key)
router.post("/:id/public-key", auth, async (req, res, next) => {
  try {
    const nominee = await Nominee.findOne({ where: { id: req.params.id } });
    if (!nominee) return res.status(404).json({ message: "Nominee not found" });

    if (nominee.nomineeAccountId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { publicKey } = req.body;
    if (!publicKey) return res.status(400).json({ message: "publicKey required" });

    nominee.publicKey = publicKey;
    await nominee.save();

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/nominees/me  — returns nominee record(s) for authenticated nominee account
router.get("/me", auth, async (req, res, next) => {
  try {
    const nominees = await Nominee.findAll({ where: { nomineeAccountId: req.user.id } });
    res.json({ success: true, nominees });
  } catch (err) {
    next(err);
  }
});

export default router;

