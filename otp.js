// Login 2FA: generate, hash, and deliver one-time codes via SMS or email —
// the user picks which, after their password is checked. See db.js's
// User.otp* columns and auth.js's /login, /login/send-otp,
// /login/verify-otp.

import crypto from "crypto";
import twilio from "twilio";
import { Resend } from "resend";

export const OTP_TTL_MS = 2 * 60 * 1000; // 2 minutes, per the product requirement
export const OTP_MAX_ATTEMPTS = 5;        // guards brute-forcing a 6-digit code in that window

// Shared footer for every transactional email this app sends (verify,
// reset, OTP) — identifies the legal operator behind the ShadowVault brand,
// not just a bare message body. auth.js reuses this same constant.
export const EMAIL_FOOTER_HTML =
  `<p style="color:#888;font-size:12px;margin-top:24px;">Sent by SealKeep Technology Inc.</p>`;

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
  console.warn("⚠️  TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — SMS won't be offered as a login OTP option for any user.");
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
    body: `Your ShadowVault verification code is ${code}. It expires in 2 minutes.`,
    from: TWILIO_FROM_NUMBER,
    to: phone,
  });
}

async function sendOtpEmail(email, code) {
  if (!resend) throw new Error("Resend not configured");
  // Resend returns { data, error } on failure rather than throwing — without
  // this check, a failed send (bad API key, unverified sending domain, etc.)
  // would look identical to a successful one to every caller, including
  // sendOtpToChannel()'s "report failure back, don't silently swap channels"
  // contract (see its own comment) — so this has to actually throw.
  const result = await resend.emails.send({
    from: RESEND_FROM_EMAIL,
    to: email,
    subject: "Your ShadowVault verification code",
    html: `<p>Your verification code is <strong>${code}</strong>. It expires in 2 minutes.</p>${EMAIL_FOOTER_HTML}`,
  });
  if (result.error) throw new Error(result.error.message || "Resend send failed");
}

/**
 * Which channels this user can actually receive a login OTP on, for the
 * frontend to offer as choices after the password step. SMS only appears
 * when both a phone is on file AND Twilio is configured — offering a
 * channel that's guaranteed to fail is worse than not offering it. Email
 * always appears: if Resend isn't configured (local dev), sendOtpToChannel()
 * logs the code to the console instead of sending, rather than the channel
 * silently not existing.
 * @returns {("sms"|"email")[]}
 */
export function getAvailableChannels(user) {
  const channels = [];
  if (user.phone && twilioClient) channels.push("sms");
  channels.push("email");
  return channels;
}

/**
 * Send a login OTP via the specific channel the user chose. Does NOT fall
 * back to another channel on failure — the user picked this one on purpose,
 * so a failure should be reported back (the frontend can offer to try a
 * different channel), not silently swapped underneath them.
 * @param {"sms"|"email"} channel
 */
export async function sendOtpToChannel(user, channel, code) {
  if (channel === "sms") {
    if (!user.phone) throw new Error("No phone number on file");
    await sendOtpSms(user.phone, code);
    return;
  }

  if (channel === "email") {
    if (resend) {
      await sendOtpEmail(user.email, code);
    } else {
      console.warn(`[OTP] RESEND_API_KEY not set — code for ${user.email} is: ${code} (dev fallback, logged only, not sent)`);
    }
    return;
  }

  throw new Error(`Unknown OTP channel: ${channel}`);
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
