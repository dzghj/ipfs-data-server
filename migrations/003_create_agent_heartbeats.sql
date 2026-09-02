-- Last-seen + Ollama status pushed by the ipfs-AI-control agent.
-- The agent is Tailscale-only, so GitHub's runners can't probe it directly;
-- it POSTs /api/internal/agent/heartbeat and the ai-health-check workflow reads
-- GET /api/internal/agent/heartbeat, alerting if the row is stale. One row.
CREATE TABLE IF NOT EXISTS public."AgentHeartbeats" (
  name           TEXT PRIMARY KEY,
  "ollamaStatus" TEXT,
  "ollamaModel"  TEXT,
  detail         JSONB,
  "lastSeenAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
