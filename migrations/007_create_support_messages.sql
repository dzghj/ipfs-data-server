-- 24/7 Support chat widget. A user's message is stored here, enqueued to the
-- ipfs-AI-control agent as an AgentEvent (type "support_message"), and the
-- agent's Ollama-generated reply is written back to this row when it answers.
-- The frontend polls GET /api/support/message/:id for the reply instead of
-- touching the raw AgentEvents queue.

CREATE TABLE IF NOT EXISTS public."SupportMessages" (
  id             SERIAL PRIMARY KEY,
  "userId"       INTEGER NOT NULL,
  message        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | answered | failed
  reply          TEXT,
  "agentEventId" INTEGER,
  "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "answeredAt"   TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_support_messages_user_id
  ON public."SupportMessages" ("userId", "createdAt");
