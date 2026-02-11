// ipfs-client.js
import { create } from "ipfs-http-client";

// Use your VM public IP and Nginx port (8080)
const IPFS_HOST = "34.70.135.218";
const IPFS_PORT = 8080;          // nginx proxy port.  8080 for reading only 5001 write and read  API 
const IPFS_PROTOCOL = "http";    // http is fine for testing; can switch to https if you have SSL

// Connect to remote IPFS node via Nginx
export const ipfs = create({
  url: `${IPFS_PROTOCOL}://${IPFS_HOST}:${IPFS_PORT}`,
});

console.log(`✅ Connected to IPFS at ${IPFS_PROTOCOL}://${IPFS_HOST}:${IPFS_PORT}`);
