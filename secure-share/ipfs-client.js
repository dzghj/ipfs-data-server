// ipfs-client.js
import { create } from "ipfs-http-client";

// IPFS_HOST/IPFS_PORT point at whatever is fronting Kubo's RPC API with the
// X-Secret-Key check below — historically VM1's public IP + nginx on a plain
// http port; now the Mac Mini agent's ngrok tunnel (https, no explicit port).
const IPFS_HOST = process.env.IPFS_HOST;
const IPFS_PORT = process.env.IPFS_PORT || "";    // omit for a bare https domain (e.g. ngrok)
const IPFS_PROTOCOL = process.env.IPFS_PROTOCOL || "http"; // "https" for the ngrok-fronted Mac Mini

// 🔐 Secret from environment variable
const IPFS_SECRET = process.env.IPFS_SECRET;

if (!IPFS_SECRET) {
  console.warn("⚠️ IPFS_SECRET is not defined in environment variables");
}

const IPFS_API_URL = `${IPFS_PROTOCOL}://${IPFS_HOST}${IPFS_PORT ? `:${IPFS_PORT}` : ""}`;

export const ipfs = create({
  url: IPFS_API_URL,
  headers: {
    "X-Secret-Key": IPFS_SECRET
  }
});

console.log(`✅ Connected to IPFS at ${IPFS_API_URL}`);
