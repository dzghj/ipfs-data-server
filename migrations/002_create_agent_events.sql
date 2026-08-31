CREATE TABLE IF NOT EXISTS public."AgentEvents" (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision JSONB,
  outcome JSONB,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "deliveredAt" TIMESTAMP WITH TIME ZONE,
  "processedAt" TIMESTAMP WITH TIME ZONE
);

-- pull query: pending, or delivered-but-stale (agent crashed before ack)
CREATE INDEX IF NOT EXISTS idx_agent_events_status_created
  ON public."AgentEvents" (status, "createdAt");
