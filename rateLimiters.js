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
