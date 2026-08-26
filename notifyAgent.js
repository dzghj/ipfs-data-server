// Event notifications to the ipfs-AI-control agent.
// See ipfs-AI-control/IPFS_AI_CONTROL_DESIGN.md sections 4.1 (GitHub Actions) and 4.2 (Backend API).

const AGENT_URL = process.env.AGENT_URL;
const AGENT_SECRET = process.env.AGENT_SECRET;

function agentEndpoint(path) {
  if (!AGENT_URL) return null;
  return `${AGENT_URL.replace(/\/$/, "")}${path}`;
}

// Fire-and-forget — used for events originating in this server (upload, login, error).
export function notifyAgent(payload) {
  const url = agentEndpoint("/event/backend");
  if (!url || !AGENT_SECRET) return;

  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.warn("[AGENT] notify failed:", err.message);
  });
}

// Awaited — relays GitHub Actions check results received on /api/internal/github-event
// to the agent, and returns/throws so the caller can report success back upstream.
export async function forwardGithubEvent(payload) {
  const url = agentEndpoint("/event/github");
  if (!url || !AGENT_SECRET) {
    throw new Error("AGENT_URL/AGENT_SECRET not configured on backend");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Agent responded ${res.status}: ${text}`);
  }

  return data;
}
