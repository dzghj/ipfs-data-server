import express from "express";
import { User, Keyholder } from "./db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Resend } from "resend";

const router = express.Router();
const SECRET = process.env.JWT_SECRET || "supersecret";
const resend = new Resend(process.env.RESEND_API_KEY);


/* ==============================
   REGISTER (Email First)
================================ */

router.post("/register", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email required" });
    }

    // Check if user already exists
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      if (existing.verified) {
        return res.status(400).json({ message: "Email already registered" });
      } else {
        // unverified user exists, maybe resend token
        return res.status(409).json({ message: "Email already registered but not verified. Please check your email or resend verification." });
      }
    }

    // Generate verification token
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyTokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24h

    // Create user with no password yet
    const user = await User.create({
      email,
      verifyToken,
      verifyTokenExpiry,
      verified: false,
    });

    // Send verification email
    const clientUrl = process.env.CLIENT_URL.replace(/\/$/, "");
    const verifyLink = `${clientUrl}/set-password/${verifyToken}`;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: "Verify your email & set password",
      html: `<p>Set your password <a href="${verifyLink}">here</a></p>`,
    });

    res.status(201).json({ message: "Verification email sent" });

  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ message: "Registration failed" });
  }
});

/* ==============================
   SET PASSWORD
================================ */
router.post("/set-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) return res.status(400).json({ message: "Password required" });

    // Find user by token
    const user = await User.findOne({ where: { verifyToken: token } });
    if (!user) return res.status(404).json({ message: "Invalid token" });

    // Check if token expired
    if (user.verifyTokenExpiry < Date.now()) {
      // Token expired → delete unverified user
      await user.destroy();
      return res.status(410).json({ message: "Token expired. Please register again." });
    }

    // Set password & verify user
    user.passwordHash = bcrypt.hashSync(password, 8);
    user.verified = true;
    user.verifyToken = null;
    user.verifyTokenExpiry = null;
    await user.save();

    // Auto-login: generate JWT
    const tokenJWT = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: "1d" });

    res.json({
      message: "Password set successfully",
      token: tokenJWT,
      user: { id: user.id, email: user.email },
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal error" });
  }
});
/* ==============================
   RESEND VERIFICATION
================================ */
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });

    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ message: "No user found" });

    if (user.verified) {
      return res.status(400).json({ message: "User already verified" });
    }

    // If expired, delete old user and ask to register again
    if (user.verifyTokenExpiry < Date.now()) {
      await user.destroy();
      return res.status(410).json({ message: "Verification token expired. Please register again." });
    }

    // Generate new token & expiry
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyTokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24h
    user.verifyToken = verifyToken;
    user.verifyTokenExpiry = verifyTokenExpiry;
    await user.save();

    const clientUrl = process.env.CLIENT_URL.replace(/\/$/, "");
    const verifyLink = `${clientUrl}/set-password/${verifyToken}`;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: "Verify your email",
      html: `<p>Set your password <a href="${verifyLink}">here</a></p>`,
    });

    res.json({ message: "Verification email resent" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal error" });
  }
});

/* ==============================
   LOGIN
================================ */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ where: { email } });

    if (!user || !user.passwordHash) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    if (!user.isVerified) {
      return res.status(403).json({ message: "Please verify your email first" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email }
    });

  } catch (err) {
    res.status(500).json({ message: "Login failed" });
  }
});
/* ===== Forgot Password ===== */
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email required" });
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      return res.status(404).json({ message: "No user found" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiry = Date.now() + 15 * 60 * 1000;

    user.resetToken = resetToken;
    user.resetTokenExpiry = expiry;
    await user.save();

    const clientUrl = process.env.CLIENT_URL.replace(/\/$/, "");
    const resetLink = `${clientUrl}/reset-password/${resetToken}`;

    const emailResponse = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: "Password Reset",
      html: `<p>Reset <a href="${resetLink}">here</a></p>`,
    });

    if (emailResponse.error) {
      return res.status(500).json({
        message: "Failed to send reset email",
        error: emailResponse.error.message,
      });
    }

    res.json({ message: "Reset email sent" });

  } catch (err) {
    res.status(500).json({
      message: "Internal error",
    });
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