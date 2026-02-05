import express from "express";
import { User, Keyholder } from "./db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Resend } from "resend";

const router = express.Router();
const SECRET = process.env.JWT_SECRET || "supersecret";
const resend = new Resend(process.env.RESEND_API_KEY);

/* ===== Register ===== */
router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email + password required" });

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: "Email exists" });

    const passwordHash = bcrypt.hashSync(password, 8);
    const user = await User.create({ email, passwordHash });

    const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: "1d" });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Register failed" });
  }
});

/* ===== Login ===== */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email } });
  if (!user) return res.status(401).json({ message: "Invalid credentials" });

  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) return res.status(401).json({ message: "Invalid credentials" });

  const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: "1d" });
  res.json({ token, user: { id: user.id, email: user.email } });
});

/* ===== Forgot Password ===== */
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ message: "No user found" });

    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiry = Date.now() + 15 * 60 * 1000;

    user.resetToken = resetToken;
    user.resetTokenExpiry = expiry;
    await user.save();

    const clientUrl = process.env.CLIENT_URL.replace(/\/$/, "");
    const resetLink = `${clientUrl}/reset-password/${resetToken}`;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: "Password Reset",
      html: `<p>Reset <a href="${resetLink}">here</a></p>`,
    });

    res.json({ message: "Reset email sent" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal error" });
  }
});

/* ===== Reset Password ===== */
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  const user = await User.findOne({ where: { resetToken: token } });
  if (!user) return res.status(400).json({ message: "Invalid token" });
  if (Date.now() > user.resetTokenExpiry) return res.status(400).json({ message: "Token expired" });

  user.passwordHash = bcrypt.hashSync(newPassword, 8);
  user.resetToken = null;
  user.resetTokenExpiry = null;
  await user.save();

  res.json({ message: "Password reset successfully" });
});

/* ===== JWT Auth Middleware ===== */
export function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(403).json({ message: "No token" });

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

export default router;