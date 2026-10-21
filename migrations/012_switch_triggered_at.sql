-- Dead-man's-switch tracking. Set by the checkin sweep
-- (POST /api/internal/run-checkin-check in index.js) the first time it finds
-- a user overdue for check-in, so nominee access is auto-granted exactly
-- once per missed period instead of being re-sent on every cron tick.
-- Cleared back to NULL on the user's next successful login (auth.js's
-- /login/verify-otp), which is also what resets lastCheckinAt and lets the
-- switch re-arm. Mirrored in db.js's BOOTSTRAP_SQL — keep both in sync.
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "switchTriggeredAt" TIMESTAMP WITH TIME ZONE;
