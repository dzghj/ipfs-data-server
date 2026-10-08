-- Login 2FA: a one-time code sent by SMS (first choice, if the user has a
-- phone on file) or email (fallback — either because SMS delivery failed,
-- or because the account predates phone being required at registration),
-- which the user must enter to complete login. See otp.js and auth.js's
-- /login, /login/verify-otp, /login/resend-otp.
--
-- otpCode is sha256(rawCode) — same one-way treatment as every other token
-- on this table (verifyToken, resetToken): only ever compared, never
-- recovered, so there's no reason to store it recoverable. The raw 6-digit
-- code exists only in the SMS/email it was sent in, for its 2-minute life.
--
-- phone is nullable: required for NEW registrations going forward, but
-- existing accounts have none and simply get their OTP by email instead
-- (deliverOtp() in otp.js falls back automatically).

ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpCode" TEXT;
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpExpiry" BIGINT;
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpChannel" TEXT;
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "otpAttempts" INTEGER NOT NULL DEFAULT 0;
