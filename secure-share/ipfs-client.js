// ipfs-client.js
import { create } from "ipfs-http-client";

// IPFS_HOST/IPFS_PORT point at whatever is fronting Kubo's RPC API with the
// X-Secret-Key check below — historically VM1's public IP + nginx on a plain
// http port; now the Mac Mini's Tailscale Funnel URL (https, no explicit
// port), routed through a local path-based proxy on the Mac Mini
// (legacychain-ipfs-proxy.js) that forwards /ipfs/* -> the real Kubo API and
// /cluster/* -> the Cluster REST API, since Funnel only exposes one port.
const IPFS_HOST = process.env.IPFS_HOST;
const IPFS_PORT = process.env.IPFS_PORT || "";    // omit for a bare https domain (e.g. ngrok/Funnel)
const IPFS_PROTOCOL = process.env.IPFS_PROTOCOL || "http"; // "https" for the Funnel-fronted Mac Mini
// ipfs-http-client defaults apiPath to "api/v0" off the bare host, which
// misses the proxy's "/ipfs" prefix entirely. Set IPFS_API_PATH=/ipfs/api/v0
// when going through the proxy; leave unset for a direct connection.
const IPFS_API_PATH = process.env.IPFS_API_PATH || "api/v0";

// 🔐 Secret from environment variable
const IPFS_SECRET = process.env.IPFS_SECRET;

if (!IPFS_SECRET) {
  console.warn("⚠️ IPFS_SECRET is not defined in environment variables");
}

const IPFS_API_URL = `${IPFS_PROTOCOL}://${IPFS_HOST}${IPFS_PORT ? `:${IPFS_PORT}` : ""}`;

export const ipfs = create({
  url: IPFS_API_URL,
  apiPath: IPFS_API_PATH,
  headers: {
    "X-Secret-Key": IPFS_SECRET
  }
});

console.log(`✅ Connected to IPFS at ${IPFS_API_URL} (apiPath: ${IPFS_API_PATH})`);
