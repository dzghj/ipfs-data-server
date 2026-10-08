import express from "express";
import { User } from "./db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Resend } from "resend";
import { notifyAgent } from "./notifyAgent.js";
import {
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  generateOtpCode,
  hashOtp,
  deliverOtp,
  maskPhone,
  maskEmail,
} from "./otp.js";

const router = express.Router();
const SECRET = process.env.JWT_SECRET || "supersecret";

// Loose E.164 check: optional leading "+", 8-15 digits total. Twilio requires
// E.164 for the "to" number, so reject anything that clearly isn't before it
// ever reaches send time.
const PHONE_RE = /^\+?[1-9]\d{7,14}$/;

// Short-lived credential for the gap between "password checked out" and
// "OTP confirmed" — same signed-JWT pattern index.js already uses for
// nominee_access tokens, so no new session store is needed. Deliberately
// NOT the final login token: it carries no file/vault access, only enough
// to prove step 1 passed and say whose OTP this is.
const OTP_PENDING_TTL = "5m";
function signOtpPending(userId) {
  return jwt.sign({ id: userId, type: "login_otp_pending" }, SECRET, { expiresIn: OTP_PENDING_TTL });
}
function verifyOtpPending(pendingToken) {
  const payload = jwt.verify(pendingToken, SECRET); // throws on invalid/expired
  if (payload.type !== "login_otp_pending") throw new Error("Wrong token type");
  return payload;
}

// verifyToken/resetToken are bearer credentials mailed to the user and looked
// up by exact equality — never recovered, only compared — so they belong in
// the DB as a one-way hash, same as passwordHash. The raw value only ever
// exists in the email link; a DB leak alone no longer hands over a usable
// link. hashToken() always returns the sha256 hex of whatever raw string is
// handed to it.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;


/* ==============================
   REGISTER (Email First)
================================ */

router.post("/register", async (req, res) => {
  try {
    const { email, phone } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email required" });
    }
    if (!phone) {
      return res.status(400).json({ message: "Phone number required" });
    }
    if (!PHONE_RE.test(phone)) {
      return res.status(400).json({ message: "Phone number must be in international format, e.g. +14155551234" });
    }

    // Check if user already exists
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      if (existing.isVerified) {
        return res.status(400).json({ message: "Email already registered" });
      } else {
        // unverified user exists, maybe resend token
        return res.status(409).json({ message: "Email already registered but not verified. Please check your email or resend verification." });
      }
    }

    // Generate verification token
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyTokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24h

    // Create user with no password yet — store only the hash; the raw token
    // only ever exists in the email link (see hashToken() above). Phone is
    // required here (this is the destination for login OTP codes, see
    // otp.js) but stays nullable on the model for accounts created before
    // this existed.
    const user = await User.create({
      email,
      phone,
      verifyToken: hashToken(verifyToken),
      verifyTokenExpiry,
      isVerified: false,
    });

    // Send verification email
    const clientUrl = process.env.CLIENT_URL.replace(/\/$/, "");
    const verifyLink = `${clientUrl}/set-password/${verifyToken}`;

    if (resend) {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: email,
        subject: "Verify your email & set password",
        html: `<p>Set your password <a href="${verifyLink}">here</a></p>`,
      });
    } else {
      console.log("Skipping email send (RESEND_API_KEY not set). Verify link:", verifyLink);
    }

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

    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    const user = await User.findOne({ where: { verifyToken: hashToken(token) } });

    if (!user) {
      return res.status(404).json({ message: "Invalid token" });
    }

    if (!user.verifyTokenExpiry || user.verifyTokenExpiry < Date.now()) {
      return res.status(410).json({
        message: "Verification token expired. Please request a new one.",
      });
    }

    user.passwordHash = bcrypt.hashSync(password, 8);
    user.isVerified = true;
    user.verifyToken = null;
    user.verifyTokenExpiry = null;

    await user.save();

    const tokenJWT = jwt.sign(
      { id: user.id, email: user.email },
      SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      message: "Password set successfully",
      token: tokenJWT,
      user: { id: user.id, email: user.email },
    });
  } catch (err) {
    console.error("Set password error:", err);
    res.status(500).json({ message: "Internal error" });
  }
});
/* ==============================
   RESEND VERIFICATION
================================ */
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email required" });
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      return res.status(404).json({ message: "No user found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "User already verified" });
    }

    // Always generate new token (even if expired)
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;

    user.verifyToken = hashToken(verifyToken);
    user.verifyTokenExpiry = verifyTokenExpiry;

    await user.save();

    const clientUrl = process.env.CLIENT_URL.replace(/\/$/, "");
    const verifyLink = `${clientUrl}/set-password/${verifyToken}`;

    if (resend) {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: email,
        subject: "Verify your email",
        html: `<p>Set your password <a href="${verifyLink}">here</a></p>`,
      });
    } else {
      console.log("Skipping email send (RESEND_API_KEY not set). Verify link:", verifyLink);
    }

    res.json({ message: "Verification email resent" });
  } catch (err) {
    console.error("Resend verification error:", err);
    res.status(500).json({ message: "Internal error" });
  }
});

/* ==============================
VERIFY TOKEN (Before Set Password)
================================ */
router.get("/verify-token/:token", async (req, res) => {
try {
const { token } = req.params;

if (!token) {
return res.status(400).json({ message: "Token required" });
}

const user = await User.findOne({ where: { verifyToken: hashToken(token) } });

if (!user) {
return res.status(404).json({ message: "Invalid verification token" });
}

if (user.isVerified) {
return res.status(400).json({ message: "User already verified" });
}

if (!user.verifyTokenExpiry || user.verifyTokenExpiry < Date.now()) {
return res.status(410).json({
message: "Verification token expired. Please request a new one.",
});
}

// Token is valid
res.json({ email: user.email });

} catch (err) {
console.error("Verify token error:", err);
res.status(500).json({ message: "Internal error" });
}
});


/* ==============================
   LOGIN
================================ */
// Step 1: check password, then issue an OTP challenge instead of the final
// login token. The real token isn't handed out until /login/verify-otp
// succeeds — see otp.js for delivery and the module comment above for why
// pendingToken is a separate, narrowly-scoped JWT.
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

    const code = generateOtpCode();
    user.otpCode = hashOtp(code);
    user.otpExpiry = Date.now() + OTP_TTL_MS;
    user.otpAttempts = 0;
    const channel = await deliverOtp(user, code);
    user.otpChannel = channel;
    await user.save();

    res.json({
      otpRequired: true,
      channel,
      maskedDestination: channel === "sms" ? maskPhone(user.phone) : maskEmail(user.email),
      pendingToken: signOtpPending(user.id),
      expiresInSeconds: OTP_TTL_MS / 1000,
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

// Step 2: confirm the OTP and issue the real login token. This is the point
// that actually completes a login — loginAt/lastLogin, the login_token JWT,
// and the user_login notifyAgent event all moved here from the old
// single-step /login.
router.post("/login/verify-otp", async (req, res) => {
  try {
    const { pendingToken, code } = req.body;
    if (!pendingToken || !code) {
      return res.status(400).json({ message: "pendingToken and code are required" });
    }

    let payload;
    try {
      payload = verifyOtpPending(pendingToken);
    } catch (err) {
      return res.status(401).json({ message: "Login session expired — please log in again" });
    }

    const user = await User.findByPk(payload.id);
    if (!user || !user.otpCode) {
      return res.status(401).json({ message: "Login session expired — please log in again" });
    }

    if (!user.otpExpiry || user.otpExpiry < Date.now()) {
      return res.status(410).json({ message: "Code expired — request a new one" });
    }

    if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ message: "Too many incorrect attempts — request a new code" });
    }

    if (hashOtp(String(code)) !== user.otpCode) {
      user.otpAttempts += 1;
      await user.save();
      return res.status(401).json({ message: "Incorrect code" });
    }

    // Success — clear the OTP so it can't be reused, then complete login.
    user.otpCode = null;
    user.otpExpiry = null;
    user.otpChannel = null;
    user.otpAttempts = 0;

    const previousLogin = user.loginAt;
    if (previousLogin) {
      user.lastLogin = previousLogin;
    }
    user.loginAt = new Date();
    await user.save();

    const token = jwt.sign(
      { id: user.id, email: user.email },
      SECRET,
      { expiresIn: "1d" }
    );

    notifyAgent({ type: "user_login", userId: user.id, ip: req.ip });

    res.json({
      token,
      user: { id: user.id, email: user.email, riskScore: user.riskScore, riskAnalysis: user.riskAnalysis, maxFileNumber: user.maxFileNumber, lastLogin: user.lastLogin }
    });

  } catch (err) {
    console.error("OTP verify error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

// Re-send a fresh code against the same pending login (e.g. the first SMS
// never arrived within its 2-minute window). Resets attempts too.
router.post("/login/resend-otp", async (req, res) => {
  try {
    const { pendingToken } = req.body;
    if (!pendingToken) {
      return res.status(400).json({ message: "pendingToken is required" });
    }

    let payload;
    try {
      payload = verifyOtpPending(pendingToken);
    } catch (err) {
      return res.status(401).json({ message: "Login session expired — please log in again" });
    }

    const user = await User.findByPk(payload.id);
    if (!user) {
      return res.status(401).json({ message: "Login session expired — please log in again" });
    }

    const code = generateOtpCode();
    user.otpCode = hashOtp(code);
    user.otpExpiry = Date.now() + OTP_TTL_MS;
    user.otpAttempts = 0;
    const channel = await deliverOtp(user, code);
    user.otpChannel = channel;
    await user.save();

    res.json({
      otpRequired: true,
      channel,
      maskedDestination: channel === "sms" ? maskPhone(user.phone) : maskEmail(user.email),
      pendingToken,
      expiresInSeconds: OTP_TTL_MS / 1000,
    });

  } catch (err) {
    console.error("OTP resend error:", err);
    res.status(500).json({ message: "Failed to resend code" });
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

    user.resetToken = hashToken(resetToken);
    user.resetTokenExpiry = expiry;
    await user.save();

    const clientUrl = process.env.CLIENT_URL.replace(/\/$/, "");
    const resetLink = `${clientUrl}/reset-password/${resetToken}`;

    if (resend) {
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
    } else {
      console.log("Skipping reset email (RESEND_API_KEY not set). Reset link:", resetLink);
      res.json({ message: "Reset link generated (skipped email send in dev)" });
    }

  } catch (err) {
    res.status(500).json({
      message: "Internal error",
    });
  }
});

/* ===== Reset Password ===== */
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  const user = await User.findOne({ where: { resetToken: hashToken(token) } });
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