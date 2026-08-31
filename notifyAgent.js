// Event queue for the ipfs-AI-control agent.
//
// The agent runs on the Mac Mini (Tailscale-only, no public inbound), so the
// backend cannot push to it. Instead every event is written to the AgentEvents
// table and the agent pulls it via GET /api/internal/agent/events.
//
// See ipfs-AI-control/IPFS_AI_CONTROL_DESIGN.md.

import { AgentEvent } from "./db.js";

// Fire-and-forget — events originating in this server (upload, login, error).
export function notifyAgent(payload) {
  AgentEvent.create({
    source: "backend",
    type: payload?.type ?? null,
    payload,
    status: "pending",
  }).catch((err) => {
    console.warn("[AGENT] enqueue failed:", err.message);
  });
}

// Awaited — GitHub Actions check results received on /api/internal/github-event.
export async function enqueueGithubEvent(payload) {
  const row = await AgentEvent.create({
    source: "github",
    type: payload?.workflow ?? null,
    payload,
    status: "pending",
  });
  return { id: row.id, queued: true };
}
