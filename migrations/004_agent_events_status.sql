-- Widen the AgentEvents lifecycle so a pulled-but-not-completed event is visible
-- and bounded instead of retrying forever.
--
-- status vocabulary (was: pending | delivered | done):
--   pending   → enqueued, not yet pulled
--   delivered → leased to the agent, in-flight
--   done      → agent reported back, action succeeded
--   failed    → agent reported back, but decision was null or outcome.success = false
--   dead      → pulled AGENT_MAX_ATTEMPTS times without an ack (poison pill), given up
--
-- attempts  → incremented each time GET /api/internal/agent/events hands the row out
-- lastError → short human-readable reason for a failed/dead row (no need to open outcome)

ALTER TABLE public."AgentEvents" ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public."AgentEvents" ADD COLUMN IF NOT EXISTS "lastError" TEXT;

-- Backfill: rows already reported as a failure by the agent become 'failed'.
UPDATE public."AgentEvents"
   SET status = 'failed'
 WHERE status = 'done'
   AND (decision IS NULL OR (outcome ->> 'success') = 'false');
