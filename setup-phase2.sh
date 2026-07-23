#!/bin/bash
# Phase 2 — IPFS Cluster Setup on VM2 (joins VM1)
# Run as: bash setup-phase2.sh
set -e
LOG="/tmp/phase2.log"
exec > >(tee -a $LOG) 2>&1

echo "===== Phase 2 IPFS Cluster Setup (VM2) ====="
echo "Started: $(date)"

# ── Config ───────────────────────────────────────────────────────
CLUSTER_SECRET="53737ecb66e2aebfdc20ac12f952faeb9f910c144cd8c8d0756965492755c8b7"
VM1_PEER_MULTIADDR="/ip4/104.198.148.182/tcp/9096/p2p/12D3KooWGsokD88SUdrby2vkzC1mRbqeChur73gyrKkYWeAKYbif"
CLUSTER_VERSION="1.1.1"
ARCH="linux-amd64"

# ── Step 1: Store cluster secret ─────────────────────────────────
echo ""
echo "[Step 1] Storing cluster secret..."
sudo mkdir -p /etc/ipfs-cluster
echo "CLUSTER_SECRET=$CLUSTER_SECRET" | sudo tee /etc/ipfs-cluster/env > /dev/null
sudo chmod 600 /etc/ipfs-cluster/env
sudo chown root:root /etc/ipfs-cluster/env
echo "[Step 1] ✅ Cluster secret stored"

# ── Step 2: Install ipfs-cluster-service ─────────────────────────
echo ""
echo "[Step 2] Installing ipfs-cluster-service v${CLUSTER_VERSION}..."
cd /tmp

# Service binary
SVC_FILE="ipfs-cluster-service_v${CLUSTER_VERSION}_${ARCH}.tar.gz"
SVC_URL="https://dist.ipfs.tech/ipfs-cluster-service/v${CLUSTER_VERSION}/${SVC_FILE}"
echo "Downloading $SVC_URL ..."
curl -L -o "$SVC_FILE" "$SVC_URL"
rm -rf /tmp/ipfs-cluster-service-extract && mkdir /tmp/ipfs-cluster-service-extract
tar -xzf "$SVC_FILE" -C /tmp/ipfs-cluster-service-extract
sudo cp $(find /tmp/ipfs-cluster-service-extract -name "ipfs-cluster-service" -type f) /usr/local/bin/ipfs-cluster-service
sudo chmod +x /usr/local/bin/ipfs-cluster-service

# CTL binary
CTL_FILE="ipfs-cluster-ctl_v${CLUSTER_VERSION}_${ARCH}.tar.gz"
CTL_URL="https://dist.ipfs.tech/ipfs-cluster-ctl/v${CLUSTER_VERSION}/${CTL_FILE}"
echo "Downloading $CTL_URL ..."
curl -L -o "$CTL_FILE" "$CTL_URL"
rm -rf /tmp/ipfs-cluster-ctl-extract && mkdir /tmp/ipfs-cluster-ctl-extract
tar -xzf "$CTL_FILE" -C /tmp/ipfs-cluster-ctl-extract
sudo cp $(find /tmp/ipfs-cluster-ctl-extract -name "ipfs-cluster-ctl" -type f) /usr/local/bin/ipfs-cluster-ctl
sudo chmod +x /usr/local/bin/ipfs-cluster-ctl

echo "[Step 2] ✅ Installed: $(ipfs-cluster-service --version) / $(ipfs-cluster-ctl --version)"

# ── Step 3: Initialize with CRDT + bootstrap to VM1 ─────────────
echo ""
echo "[Step 3] Initializing ipfs-cluster with CRDT consensus..."
export CLUSTER_SECRET=$CLUSTER_SECRET

# Remove any previous init
rm -rf ~/.ipfs-cluster

ipfs-cluster-service init --consensus crdt 2>&1 || true

if [ -f "$HOME/.ipfs-cluster/service.json" ]; then
  echo "[Step 3] ✅ service.json created"
else
  echo "[Step 3] ❌ Init failed"
  exit 1
fi

# ── Step 4: Configure service.json — set bootstrap peer ──────────
echo ""
echo "[Step 4] Configuring service.json with VM1 bootstrap..."

python3 -c "
import json
with open('$HOME/.ipfs-cluster/service.json') as f:
    cfg = json.load(f)

cfg.setdefault('cluster', {})
cfg['cluster']['replication_factor_min'] = 2
cfg['cluster']['replication_factor_max'] = 3
cfg['cluster']['bootstrap'] = ['$VM1_PEER_MULTIADDR']

cfg.setdefault('restapi', {})
cfg['restapi']['http_listen_multiaddress'] = '/ip4/0.0.0.0/tcp/9094'
cfg['restapi']['basic_auth_credentials'] = 'admin:LegacyChainCluster2026!'

with open('$HOME/.ipfs-cluster/service.json', 'w') as f:
    json.dump(cfg, f, indent=2)

print('service.json updated with bootstrap peer')
"
echo "[Step 4] ✅ service.json configured"

# ── Step 5: Create systemd service ───────────────────────────────
echo ""
echo "[Step 5] Creating systemd service..."
CURRENT_USER=$(whoami)

sudo tee /etc/systemd/system/ipfs-cluster.service > /dev/null <<EOF
[Unit]
Description=IPFS Cluster Daemon
After=network.target ipfs.service
Wants=ipfs.service

[Service]
User=$CURRENT_USER
EnvironmentFile=/etc/ipfs-cluster/env
ExecStart=/usr/local/bin/ipfs-cluster-service daemon --bootstrap $VM1_PEER_MULTIADDR
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

# ── Step 6: Start and verify ──────────────────────────────────────
echo ""
echo "[Step 6] Starting ipfs-cluster service..."
sudo systemctl start ipfs-cluster
sleep 5
sudo systemctl status ipfs-cluster --no-pager || true

echo ""
echo "[Step 6] Checking peer connections (waiting 10s for bootstrap)..."
sleep 10
ipfs-cluster-ctl id 2>&1 || true
ipfs-cluster-ctl peers ls 2>&1 || true

echo ""
echo "===== Phase 2 Complete ====="
echo "Log saved to: $LOG"
echo ""
echo "VERIFY:"
echo "  VM2 should now show: Sees 1 other peer (VM1)"
echo "  VM1 check: ssh david@104.198.148.182 'ipfs-cluster-ctl peers ls'"
