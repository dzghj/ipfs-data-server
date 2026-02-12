// ipfs-client.js
import { create } from "ipfs-http-client";

// Use your VM public IP and Nginx port (8080)
const IPFS_HOST = process.env.IPFS_HOST;
const IPFS_PORT = process.env.IPFS_PORT;          // nginx proxy port.  8080 for reading only 5001 write and read  API 
const IPFS_PROTOCOL = "http";    // http is fine for testing; can switch to https if you have SSL

// 🔐 Secret from environment variable
const IPFS_SECRET = process.env.IPFS_SECRET;

if (!IPFS_SECRET) {
  console.warn("⚠️ IPFS_SECRET is not defined in environment variables");
}

export const ipfs = create({
  url: `${IPFS_PROTOCOL}://${IPFS_HOST}:${IPFS_PORT}`,
  headers: {
    "X-Secret-Key": IPFS_SECRET
  }
});


console.log(`✅ Connected to IPFS at ${IPFS_PROTOCOL}://${IPFS_HOST}:${IPFS_PORT}`);
