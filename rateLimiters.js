import rateLimit from "express-rate-limit";

// Brute-force protection on the login flow — 3 attempts per 15 minutes per
// IP. Separate from otp.js's OTP_MAX_ATTEMPTS (a per-code counter stored on
// the user row, reset on every new code sent): this one caps the request
// rate itself, regardless of which account or OTP is being targeted.
// skipSuccessfulRequests so a user who gets it right on attempt 1 is never
// affected — only repeated failures count toward the limit.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
});

// Caps how often a code can be (re)sent during one login attempt. Without
// this, anyone holding a pendingToken (needs only a correct password guess,
// itself capped by loginLimiter) could call /login/send-otp in a loop and
// SMS/email-bomb the real account holder at the app's Twilio/Resend expense.
// Deliberately does NOT skipSuccessfulRequests like loginLimiter does — a
// successful send is exactly the thing that needs capping here.
export const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many code requests. Please wait a few minutes before requesting another." },
});

// Upload throttle — not a brute-force concern like login, just anti-abuse
// (scripted mass uploads). Generous enough not to interfere with normal
// use: a real user uploading a batch of files should never hit this.
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many uploads — please slow down and try again shortly." },
});
