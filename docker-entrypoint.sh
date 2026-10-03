#!/bin/sh
# Brings this container onto the tailnet, then forwards 127.0.0.1:5001 and
# 127.0.0.1:9094 to the Mac Mini's real IPFS and Cluster REST API ports over
# that private connection — so secure-share/ipfs-client.js and index.js's
# clusterPin() need no code change at all, just IPFS_HOST=127.0.0.1,
# IPFS_PORT=5001, IPFS_PROTOCOL=http, CLUSTER_API_URL=http://127.0.0.1:9094.
# No public tunnel, no secrets exposed to the internet; only tailnet members
# can ever reach these ports.
set -e

STATE_DIR=/tmp/tailscale
mkdir -p "$STATE_DIR"

if [ -z "$TS_AUTHKEY" ]; then
  echo "⚠️  TS_AUTHKEY not set — starting without Tailscale (IPFS calls will fail if IPFS_HOST points at a tailnet-only address)"
else
  echo "Starting tailscaled (userspace networking)..."
  tailscaled \
    --tun=userspace-networking \
    --socks5-server=localhost:1055 \
    --outbound-http-proxy-listen=localhost:1055 \
    --state="$STATE_DIR/tailscaled.state" \
    --statedir="$STATE_DIR" &

  for i in $(seq 1 30); do
    tailscale status >/dev/null 2>&1 && break
    sleep 1
  done

  echo "Authenticating to tailnet..."
  tailscale up \
    --authkey="$TS_AUTHKEY" \
    --hostname="${TS_HOSTNAME:-ipfs-data-server-render}" \
    --accept-routes

  for i in $(seq 1 30); do
    tailscale status 2>/dev/null | grep -q "^100\." && break
    sleep 1
  done
  echo "Tailscale up: $(tailscale status 2>/dev/null | head -1)"

  echo "Starting local forwards to ${IPFS_TAILNET_HOST:-100.73.92.84} (IPFS :${IPFS_TAILNET_PORT:-5001}, Cluster :${CLUSTER_TAILNET_PORT:-9094}) ..."
  node tailscale-forward.mjs &
fi

exec node index.js
