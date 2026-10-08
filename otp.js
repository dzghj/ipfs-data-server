// Login 2FA: generate, hash, and deliver one-time codes via SMS (preferred)
// or email (fallback). See db.js's User.otp* columns and auth.js's
// /login, /login/verify-otp, /login/resend-otp.

import crypto from "crypto";
import twilio from "twilio";
import { Resend } from "resend";

export const OTP_TTL_MS = 2 * 60 * 1000; // 2 minutes, per the product requirement
export const OTP_MAX_ATTEMPTS = 5;        // guards brute-forcing a 6-digit code in that window

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL  = process.env.RESEND_FROM_EMAIL;

const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!twilioClient) {
  console.warn("⚠️  TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — login OTP will fall back to email for every user.");
}

/** 6-digit numeric code, cryptographically random (not Math.random). */
export function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Same one-way treatment as every other token on User (see db.js). */
export function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function sendOtpSms(phone, code) {
  if (!twilioClient) throw new Error("Twilio not configured");
  await twilioClient.messages.create({
    body: `Your LegacyChain verification code is ${code}. It expires in 2 minutes.`,
    from: TWILIO_FROM_NUMBER,
    to: phone,
  });
}

async function sendOtpEmail(email, code) {
  if (!resend) throw new Error("Resend not configured");
  await resend.emails.send({
    from: RESEND_FROM_EMAIL,
    to: email,
    subject: "Your LegacyChain verification code",
    html: `<p>Your verification code is <strong>${code}</strong>. It expires in 2 minutes.</p>`,
  });
}

/**
 * Deliver a login OTP: SMS first if the user has a phone on file, falling
 * back to email if SMS isn't configured, fails to send, or there's no phone
 * at all (accounts created before phone was required at registration). If
 * neither channel is configured (local dev with no Twilio/Resend keys), logs
 * the code to the console instead of throwing — matches the existing
 * dev-friendly fallback auth.js already uses for verify/reset links.
 * @returns {Promise<"sms"|"email"|"console">}
 */
export async function deliverOtp(user, code) {
  if (user.phone) {
    try {
      await sendOtpSms(user.phone, code);
      return "sms";
    } catch (err) {
      console.warn(`[OTP] SMS failed for user ${user.id}, falling back to email:`, err.message);
    }
  }

  if (resend) {
    await sendOtpEmail(user.email, code);
    return "email";
  }

  console.warn(`[OTP] No SMS/email configured — code for ${user.email} is: ${code} (dev fallback, logged only, not sent)`);
  return "console";
}

/** "+1*******34" — last 2 digits visible, for the client to show "code sent to ...". */
export function maskPhone(phone) {
  if (!phone) return null;
  return phone.replace(/\d(?=\d{2})/g, "*");
}

/** "j***@example.com" */
export function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!name || !domain) return email;
  return `${name.slice(0, 1)}${"*".repeat(Math.max(name.length - 1, 1))}@${domain}`;
}
