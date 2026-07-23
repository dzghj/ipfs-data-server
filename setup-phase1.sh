#!/bin/bash
# Phase 1 — IPFS Cluster Setup on VM1
# Run as: sudo bash setup-phase1.sh
set -e
LOG="/tmp/phase1.log"
exec > >(tee -a $LOG) 2>&1

echo "===== Phase 1 IPFS Cluster Setup ====="
echo "Started: $(date)"

# ── Step 1: Generate cluster secret ──────────────────────────────
echo ""
echo "[Step 1] Generating cluster secret..."
CLUSTER_SECRET=$(od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n')
echo "CLUSTER_SECRET=$CLUSTER_SECRET"

# Store in env file
sudo mkdir -p /etc/ipfs-cluster
echo "CLUSTER_SECRET=$CLUSTER_SECRET" | sudo tee /etc/ipfs-cluster/env > /dev/null
sudo chmod 600 /etc/ipfs-cluster/env
sudo chown root:root /etc/ipfs-cluster/env
echo "[Step 1] ✅ Cluster secret stored at /etc/ipfs-cluster/env"

# ── Step 2: Install ipfs-cluster-service ─────────────────────────
echo ""
echo "[Step 2] Installing ipfs-cluster-service..."
cd /tmp

CLUSTER_VERSION="1.1.1"
ARCH="linux-amd64"

# Download ipfs-cluster-service
SVC_FILE="ipfs-cluster-service_v${CLUSTER_VERSION}_${ARCH}.tar.gz"
SVC_URL="https://dist.ipfs.tech/ipfs-cluster-service/v${CLUSTER_VERSION}/${SVC_FILE}"
echo "Downloading $SVC_URL ..."
wget -q --show-progress "$SVC_URL" -O "$SVC_FILE"

# Verify size > 10MB (basic corruption check)
SVC_SIZE=$(stat -c%s "$SVC_FILE" 2>/dev/null || echo 0)
echo "Downloaded size: $SVC_SIZE bytes"
if [ "$SVC_SIZE" -lt 10000000 ]; then
  echo "❌ File too small — download likely failed. Trying curl..."
  curl -L "$SVC_URL" -o "$SVC_FILE"
fi

echo "Extracting ipfs-cluster-service..."
rm -rf /tmp/ipfs-cluster-service-extract
mkdir /tmp/ipfs-cluster-service-extract
tar -xzf "$SVC_FILE" -C /tmp/ipfs-cluster-service-extract
ls -la /tmp/ipfs-cluster-service-extract/
find /tmp/ipfs-cluster-service-extract -name "ipfs-cluster-service" -type f
sudo cp $(find /tmp/ipfs-cluster-service-extract -name "ipfs-cluster-service" -type f) /usr/local/bin/ipfs-cluster-service
sudo chmod +x /usr/local/bin/ipfs-cluster-service

# Download ipfs-cluster-ctl separately
CTL_FILE="ipfs-cluster-ctl_v${CLUSTER_VERSION}_${ARCH}.tar.gz"
CTL_URL="https://dist.ipfs.tech/ipfs-cluster-ctl/v${CLUSTER_VERSION}/${CTL_FILE}"
echo "Downloading $CTL_URL ..."
curl -L "$CTL_URL" -o "$CTL_FILE"

echo "Extracting ipfs-cluster-ctl..."
rm -rf /tmp/ipfs-cluster-ctl-extract
mkdir /tmp/ipfs-cluster-ctl-extract
tar -xzf "$CTL_FILE" -C /tmp/ipfs-cluster-ctl-extract
ls -la /tmp/ipfs-cluster-ctl-extract/
find /tmp/ipfs-cluster-ctl-extract -name "ipfs-cluster-ctl" -type f
sudo cp $(find /tmp/ipfs-cluster-ctl-extract -name "ipfs-cluster-ctl" -type f) /usr/local/bin/ipfs-cluster-ctl
sudo chmod +x /usr/local/bin/ipfs-cluster-ctl

VERSION_OUT=$(ipfs-cluster-service --version 2>&1)
CTL_VERSION_OUT=$(ipfs-cluster-ctl --version 2>&1)
echo "[Step 2] ✅ Installed: $VERSION_OUT / $CTL_VERSION_OUT"

# ── Step 3: Initialize ipfs-cluster with CRDT ────────────────────
echo ""
echo "[Step 3] Initializing ipfs-cluster with CRDT consensus..."

# Run as current user (ipfs user not set up, using david)
export CLUSTER_SECRET=$CLUSTER_SECRET
ipfs-cluster-service init --consensus crdt 2>&1 || true

if [ -f "$HOME/.ipfs-cluster/service.json" ]; then
  echo "[Step 3] ✅ service.json created"
  PEER_ID=$(ipfs-cluster-service id 2>/dev/null | grep "^ID" | awk '{print $2}' || echo "run ipfs-cluster-ctl id after start")
  echo "[Step 3] Peer ID: $PEER_ID"
else
  echo "[Step 3] ❌ service.json not found — init may have failed"
fi

# ── Step 4: Configure service.json ───────────────────────────────
echo ""
echo "[Step 4] Configuring service.json..."

SERVICE_JSON="$HOME/.ipfs-cluster/service.json"

if [ -f "$SERVICE_JSON" ]; then
  # Set replication factors
  python3 -c "
import json, sys
with open('$SERVICE_JSON') as f:
    cfg = json.load(f)

cfg.setdefault('cluster', {})
cfg['cluster']['replication_factor_min'] = 2
cfg['cluster']['replication_factor_max'] = 3

cfg.setdefault('restapi', {})
cfg['restapi']['http_listen_multiaddress'] = '/ip4/0.0.0.0/tcp/9094'
cfg['restapi']['basic_auth_credentials'] = 'admin:LegacyChainCluster2026!'

with open('$SERVICE_JSON', 'w') as f:
    json.dump(cfg, f, indent=2)

print('service.json updated')
"
  echo "[Step 4] ✅ service.json configured"
else
  echo "[Step 4] ⚠️  service.json not found, skipping config"
fi

# ── Step 5: Create systemd service ───────────────────────────────
echo ""
echo "[Step 5] Creating systemd service..."

CURRENT_USER=$(whoami)
CURRENT_HOME=$HOME

sudo tee /etc/systemd/system/ipfs-cluster.service > /dev/null <<EOF
[Unit]
Description=IPFS Cluster Daemon
After=network.target ipfs.service
Wants=ipfs.service

[Service]
User=$CURRENT_USER
EnvironmentFile=/etc/ipfs-cluster/env
ExecStart=/usr/local/bin/ipfs-cluster-service daemon
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ipfs-cluster
echo "[Step 5] ✅ systemd service created and enabled"

# ── Step 6: Firewall note ─────────────────────────────────────────
echo ""
echo "[Step 6] ⚠️  GCP firewall ports 9094 and 9096 must be opened manually:"
echo "  gcloud compute firewall-rules create ipfs-cluster-ports \\"
echo "    --allow tcp:9094,tcp:9096 \\"
echo "    --target-tags ipfs-cluster \\"
echo "    --description 'IPFS Cluster REST API and swarm'"

# ── Step 7: Start and verify ──────────────────────────────────────
echo ""
echo "[Step 7] Starting ipfs-cluster service..."
sudo systemctl start ipfs-cluster || echo "Start failed — check: journalctl -u ipfs-cluster -n 50"
sleep 3
sudo systemctl status ipfs-cluster --no-pager || true

echo ""
echo "===== Phase 1 Complete ====="
echo "Log saved to: $LOG"
echo ""
echo "NEXT STEPS:"
echo "1. Open GCP firewall for ports 9094 and 9096"
echo "2. Run: ipfs-cluster-ctl id  (to get peer multiaddress)"
echo "3. Run: curl -u admin:LegacyChainCluster2026! http://104.198.148.182:9094/id"
echo "4. Record the peer multiaddress for VM2 bootstrap"
