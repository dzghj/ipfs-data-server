# Design Document: IPFS Cluster Distributed Storage

## 1. System Architecture Overview

### Component Diagram

```
                        ┌──────────────────────────────────────────────────────────────┐
                        │                    UPLOAD FLOW                               │
                        └──────────────────────────────────────────────────────────────┘

  Client
    │
    │  POST /api/upload (HTTPS)
    ▼
┌────────────────────────┐
│   Backend API (Render) │
│   Node.js / Express    │
│   secure-share/        │
│   ipfs-client.js       │
└──────────┬─────────────┘
           │
           │ 1. ipfs.add(encryptedBuffer)   → HTTP :5001  (IPFS RPC API)
           │ 2. POST /pins/<CID>            → HTTP :9094  (Cluster REST API)
           │    Authorization: Basic <b64>
           ▼
┌──────────────────────────────────────────────────────────┐
│              VM1  (104.198.148.182, us-central1-a)       │
│  ┌─────────────────────┐    ┌──────────────────────────┐ │
│  │   ipfs daemon       │    │  ipfs-cluster-service    │ │
│  │   port 5001 (API)   │◄───│  port 9094 (REST API)    │ │
│  │   port 4001 (swarm) │    │  port 9096 (cluster swarm│ │
│  └─────────────────────┘    └──────────┬───────────────┘ │
│                                         │  CRDT consensus  │
└─────────────────────────────────────────┼─────────────────┘
                                          │  TCP 9096
           ┌──────────────────────────────┼────────────────────────────┐
           │                              │                            │
           ▼                              ▼                            ▼
┌──────────────────────┐      ┌───────────────────────┐   ┌───────────────────────┐
│  VM2                 │      │  VM1 (self)           │   │  Local Mac            │
│  35.243.225.26       │      │  (leader/bootstrap)   │   │  (large storage)      │
│  us-east1-c          │      │                       │   │  macOS / Homebrew     │
│  ipfs daemon         │      │  ipfs daemon          │   │  ipfs daemon 0.39.0   │
│  ipfs-cluster-service│      │  ipfs-cluster-service │   │  ipfs-cluster-service │
│  (follower)          │      │  (bootstrap peer)     │   │  (follower)           │
└──────────────────────┘      └───────────────────────┘   └───────────────────────┘
           │                              │                            │
           └──────────── ipfs swarm (TCP 4001) ────────────────────────┘
```

### Data Flow: File Upload → Cluster-Wide Pin

```
1. Client sends encrypted file to POST /api/upload
2. Backend API encrypts buffer with AES-256-GCM (already done in secureUpload)
3. Backend calls ipfs.add(encryptedBuffer) → VM1 IPFS daemon stores block, returns CID
4. Backend calls clusterPin(cid) → POST http://VM1:9094/pins/<CID> with Basic auth
5. Cluster API on VM1 allocates pin to all available peers (up to replication_factor_max=3)
6. VM2 and Local_Node ipfs-cluster-service receive pin instruction via CRDT log (TCP 9096)
7. VM2 ipfs daemon fetches blocks from VM1 via IPFS swarm (TCP 4001) and pins locally
8. Local_Node does the same
9. Cluster API returns 200/202 to Backend API
10. Backend API writes FileRecord to PostgreSQL (CID, encryptionKey, iv, authTag, etc.)
11. Backend returns success to client
```

---

## 2. Component Design

### 2.1 IPFS Cluster Setup

**Version:** `ipfs-cluster-service` and `ipfs-cluster-ctl` v1.0.6 (latest stable as of 2025).

Install on all three nodes:

```bash
# Download and install (repeat on each node, adjust arch as needed)
wget https://dist.ipfs.tech/ipfs-cluster-service/v1.0.6/ipfs-cluster-service_v1.0.6_linux-amd64.tar.gz
tar -xzf ipfs-cluster-service_v1.0.6_linux-amd64.tar.gz
sudo mv ipfs-cluster-service/ipfs-cluster-service /usr/local/bin/
sudo mv ipfs-cluster-service/ipfs-cluster-ctl /usr/local/bin/

# macOS (Homebrew) on Local Node
brew install ipfs-cluster
```

**Generate shared cluster secret (run once, share to all nodes via secrets manager):**

```bash
od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n'
# Example output (do NOT use this value): a3f1c9d2e4b7f0a1c3e5d7b9f2a4c6e8a0b2d4f6e8a0c2d4f6e8a0b2d4f6e8a0
```

Store the output as `CLUSTER_SECRET` on each node and in GitHub Actions secrets. Never commit it.

---

#### 2.1.1 VM1 — Bootstrap / Leader Node

**Initialize cluster (first time only):**

```bash
CLUSTER_SECRET=<generated_secret> ipfs-cluster-service init --consensus crdt
```

**Edit `~/.ipfs-cluster/service.json`** (key fields):

```json
{
  "cluster": {
    "secret": "<CLUSTER_SECRET>",
    "replication_factor_min": 2,
    "replication_factor_max": 3
  },
  "restapi": {
    "http_listen_multiaddress": "/ip4/0.0.0.0/tcp/9094",
    "basic_auth_credentials": {
      "<CLUSTER_API_USER>": "<CLUSTER_API_PASSWORD>"
    }
  },
  "ipfs_connector": {
    "ipfshttp": {
      "node_multiaddress": "/ip4/127.0.0.1/tcp/5001"
    }
  }
}
```

**Systemd service file** `/etc/systemd/system/ipfs-cluster.service`:

```ini
[Unit]
Description=IPFS Cluster Service
After=network.target ipfs.service
Requires=ipfs.service

[Service]
User=ipfs-user
Environment=CLUSTER_SECRET=<from-env-or-secrets-manager>
ExecStart=/usr/local/bin/ipfs-cluster-service daemon
Restart=on-failure
RestartSec=10s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable ipfs-cluster
sudo systemctl start ipfs-cluster
```

After starting, retrieve VM1's peer multiaddr for use by VM2 and Local_Node:

```bash
ipfs-cluster-ctl id
# Note the /ip4/104.198.148.182/tcp/9096/p2p/<PEER_ID> multiaddress
```

---

#### 2.1.2 VM2 — Follower Node

**Initialize and bootstrap to VM1:**

```bash
CLUSTER_SECRET=<same_secret> ipfs-cluster-service init --consensus crdt \
  --bootstrap /ip4/104.198.148.182/tcp/9096/p2p/<VM1_PEER_ID>
```

The `bootstrap` field is also persisted in `~/.ipfs-cluster/service.json`:

```json
{
  "cluster": {
    "secret": "<CLUSTER_SECRET>",
    "peer_addresses": [
      "/ip4/104.198.148.182/tcp/9096/p2p/<VM1_PEER_ID>"
    ]
  },
  "restapi": {
    "http_listen_multiaddress": "/ip4/127.0.0.1/tcp/9094",
    "basic_auth_credentials": {
      "<CLUSTER_API_USER>": "<CLUSTER_API_PASSWORD>"
    }
  },
  "ipfs_connector": {
    "ipfshttp": {
      "node_multiaddress": "/ip4/127.0.0.1/tcp/5001"
    }
  }
}
```

Note: VM2's Cluster REST API is bound to `127.0.0.1` only — it is not externally exposed. Only VM1's port 9094 is used by the Backend API.

**Systemd service file** (identical structure to VM1, placed at `/etc/systemd/system/ipfs-cluster.service`):

```bash
sudo systemctl daemon-reload
sudo systemctl enable ipfs-cluster
sudo systemctl start ipfs-cluster
```

---

#### 2.1.3 Local Mac Node — Follower Node

The Local Mac runs macOS with Homebrew IPFS 0.39.0. The IPFS repo is configured to use a large storage volume (e.g., an external drive or secondary partition).

**Configure IPFS to use large-storage path** (run before initializing cluster):

```bash
export IPFS_PATH=/Volumes/LargeStorage/ipfs-repo
ipfs init
ipfs config Datastore.StorageMax "500GB"
```

**Initialize cluster:**

```bash
export IPFS_PATH=/Volumes/LargeStorage/ipfs-repo
export IPFS_CLUSTER_PATH=/Volumes/LargeStorage/ipfs-cluster
CLUSTER_SECRET=<same_secret> ipfs-cluster-service --config $IPFS_CLUSTER_PATH init \
  --consensus crdt \
  --bootstrap /ip4/104.198.148.182/tcp/9096/p2p/<VM1_PEER_ID>
```

**launchd plist** `~/Library/LaunchAgents/io.ipfs.cluster.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.ipfs.cluster</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ipfs-cluster-service</string>
    <string>--config</string>
    <string>/Volumes/LargeStorage/ipfs-cluster</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLUSTER_SECRET</key>
    <string><!-- load from keychain or .env, do not hardcode --></string>
    <key>IPFS_PATH</key>
    <string>/Volumes/LargeStorage/ipfs-repo</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ipfs-cluster.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ipfs-cluster-error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/io.ipfs.cluster.plist
launchctl start io.ipfs.cluster
```

**Important:** The `CLUSTER_SECRET` value in the plist should be read from macOS Keychain at startup using a wrapper script, not hardcoded directly. Example wrapper:

```bash
#!/bin/bash
export CLUSTER_SECRET=$(security find-generic-password -s "ipfs-cluster-secret" -w)
exec /usr/local/bin/ipfs-cluster-service --config /Volumes/LargeStorage/ipfs-cluster daemon
```

---

### 2.2 Cluster API Security

**Basic Authentication**

The `restapi.basic_auth_credentials` field in `service.json` on VM1 maps username → bcrypt-hashed password. ipfs-cluster-service accepts plaintext credentials over the wire and verifies them internally:

```json
"restapi": {
  "http_listen_multiaddress": "/ip4/0.0.0.0/tcp/9094",
  "basic_auth_credentials": {
    "clusteradmin": "<bcrypt_hashed_password>"
  }
}
```

All requests to port 9094 must include `Authorization: Basic <base64(user:password)>`.

**GCP Firewall Rules**

| Rule Name | Direction | Protocol/Port | Source | Target | Purpose |
|-----------|-----------|---------------|--------|--------|---------|
| `allow-cluster-swarm-internal` | Ingress | TCP 9096 | VM2 IP (35.243.225.26) | VM1 | Cluster peer gossip |
| `allow-cluster-swarm-vm1` | Ingress | TCP 9096 | VM1 IP (104.198.148.182) | VM2 | Cluster peer gossip |
| `allow-cluster-swarm-local` | Ingress | TCP 9096 | Local Mac external IP | VM1, VM2 | Local node joins cluster |
| `allow-cluster-api-render` | Ingress | TCP 9094 | Render egress IPs | VM1 only | Backend API pins CIDs |

Create the internal swarm rule via gcloud:

```bash
gcloud compute firewall-rules create allow-cluster-swarm-internal \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:9096 \
  --source-ranges=35.243.225.26/32 \
  --target-tags=ipfs-node \
  --project=gen-lang-client-0103362464

gcloud compute firewall-rules create allow-cluster-api-render \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:9094 \
  --source-ranges=<RENDER_EGRESS_CIDR> \
  --target-tags=ipfs-node \
  --project=gen-lang-client-0103362464
```

> **Note on Render egress IPs:** Render does not publish a fixed CIDR for outbound traffic on free/starter plans. Until Render provides a static IP (available on paid plans), consider using an SSH tunnel or VPN approach described in Section 5.

**Port Summary**

| Port | Protocol | Service | Exposed To |
|------|----------|---------|------------|
| 4001 | TCP | IPFS swarm (p2p) | Public (IPFS network) |
| 5001 | TCP | IPFS HTTP RPC API | Localhost only |
| 9094 | TCP | Cluster REST API | Render (Backend API) |
| 9096 | TCP | Cluster swarm (p2p) | VM1 ↔ VM2 ↔ Local Mac |

---

### 2.3 Backend API Changes

#### 2.3.1 `secure-share/ipfs-client.js` — Add `clusterPin` Function

The existing file creates an `ipfs-http-client` connection. Add the `clusterPin` function below the existing `ipfs` export:

```js
// ipfs-client.js (additions)
import { create } from "ipfs-http-client";

const IPFS_HOST = process.env.IPFS_HOST;
const IPFS_PORT = process.env.IPFS_PORT;
const IPFS_PROTOCOL = "http";
const IPFS_SECRET = process.env.IPFS_SECRET;

// --- NEW: Cluster API config ---
const CLUSTER_API_URL = process.env.CLUSTER_API_URL;       // e.g. http://104.198.148.182:9094
const CLUSTER_API_USER = process.env.CLUSTER_API_USER;
const CLUSTER_API_PASSWORD = process.env.CLUSTER_API_PASSWORD;

if (!IPFS_SECRET) {
  console.warn("⚠️  IPFS_SECRET is not defined in environment variables");
}
if (!CLUSTER_API_URL || !CLUSTER_API_USER || !CLUSTER_API_PASSWORD) {
  console.warn("⚠️  CLUSTER_API_URL, CLUSTER_API_USER, or CLUSTER_API_PASSWORD missing");
}

export const ipfs = create({
  url: `${IPFS_PROTOCOL}://${IPFS_HOST}:${IPFS_PORT}`,
  headers: { "X-Secret-Key": IPFS_SECRET },
});

/**
 * Pin a CID through the IPFS Cluster REST API.
 * Retries up to 3 times with a 5-second delay on failure.
 *
 * @param {string} cid
 * @returns {Promise<void>} resolves on success, rejects after all retries exhausted
 */
export async function clusterPin(cid) {
  const url = `${CLUSTER_API_URL}/pins/${cid}`;
  const auth = Buffer.from(`${CLUSTER_API_USER}:${CLUSTER_API_PASSWORD}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", headers });

      if (response.ok) {
        // 200 or 202 — pin accepted by cluster
        console.log(`✅ Cluster pin accepted for CID ${cid} (attempt ${attempt})`);
        return;
      }

      const body = await response.text().catch(() => "");
      const err = new Error(
        `Cluster API returned HTTP ${response.status} for CID ${cid}: ${body}`
      );

      if (attempt === MAX_ATTEMPTS) throw err;

      console.warn(`⚠️  Cluster pin attempt ${attempt} failed (${response.status}). Retrying in 5s...`);
    } catch (networkErr) {
      if (attempt === MAX_ATTEMPTS) throw networkErr;
      console.warn(`⚠️  Cluster pin attempt ${attempt} network error: ${networkErr.message}. Retrying in 5s...`);
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

console.log(`✅ Connected to IPFS at ${IPFS_PROTOCOL}://${IPFS_HOST}:${IPFS_PORT}`);
```

#### 2.3.2 `secure-share/index.js` — Updated `secureUpload`

The current `secureUpload` adds the encrypted buffer to IPFS and calls `ipfs.pin.add`. Replace `ipfs.pin.add` with `clusterPin(cid)`. The `FileRecord` write in `index.js` (the route layer) already happens after `secureUpload` returns, so the sequencing is automatically correct — the DB record is only written once `secureUpload` resolves successfully.

```js
// secure-share/index.js (modified secureUpload)
import { ipfs, clusterPin } from "./ipfs-client.js";  // add clusterPin import
import { generateKey, encrypt, decrypt, sha256 } from "./crypto-utils.js";
import { AccessLog, Nominee } from "../db.js";

export async function secureUpload({ buffer, filename, ownerId, mimeType }) {
  const fileKey = generateKey();
  const { encrypted, iv, authTag } = encrypt(buffer, fileKey);
  const hash = sha256(buffer);

  // 1. Add encrypted bytes to IPFS daemon on VM1
  const upload = await ipfs.add(encrypted);
  const cid = upload.cid.toString();

  // 2. Pin cluster-wide (retries internally; throws on final failure)
  //    The local daemon pin (ipfs.pin.add) is superseded by the cluster pin,
  //    which also pins on the local IPFS node as part of its allocation.
  await clusterPin(cid);

  // 3. Audit log — only reached if cluster pin succeeded
  await AccessLog.create({
    actorEmail: ownerId.toString(),
    role: "user",
    action: "UPLOAD",
    note: filename,
  });

  return {
    cid,
    sha256Hash: hash,
    encryptedFileKey: fileKey.toString("base64"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    filename,
    ownerId,
    mimeType,
  };
}
```

#### 2.3.3 `index.js` / Route Layer — Error Handling

The `/api/upload` route (or equivalent in `routes/files.js`) must propagate the cluster pin error as HTTP 503. Wrap the `secureUpload` call:

```js
// routes/files.js (or index.js upload route) — error handling addition
try {
  const result = await secureUpload({ buffer, filename, ownerId: user.id, mimeType });
  const record = await FileRecord.create({ ...result, userId: user.id });
  res.json({ success: true, cid: result.cid, fileId: record.id });
} catch (err) {
  if (err.message.includes("Cluster API")) {
    return res.status(503).json({ error: "IPFS cluster pin failed" });
  }
  console.error("Upload error:", err);
  res.status(500).json({ error: "Upload failed" });
}
```

The `FileRecord.create` call sits strictly after `secureUpload` resolves — if `clusterPin` throws, execution never reaches the DB write.
