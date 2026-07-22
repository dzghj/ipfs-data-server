# Implementation Tasks

## Phase 1 — VM1 Cluster Setup

- [ ] 1. Generate cluster secret and store as environment variable on VM1
  - Generate a 32-byte hex cluster secret: `od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n'`
  - Add `CLUSTER_SECRET=<hex>` to `/etc/environment` or a dedicated `/etc/ipfs-cluster/env` file
  - Ensure the file is owned by root with mode 600, not committed to version control
  - **Files**: `/etc/ipfs-cluster/env` (new, on VM1)
  - **Requirements**: Req 7.1

- [ ] 2. Install ipfs-cluster-service on VM1
  - Download the latest ipfs-cluster release binary (≥ 1.0.6) from `dist.ipfs.tech`
  - Verify checksum against the published SHA-512 manifest
  - Move `ipfs-cluster-service` and `ipfs-cluster-ctl` to `/usr/local/bin/`
  - Confirm `ipfs-cluster-service --version` reports ≥ 1.0.6
  - **Files**: `/usr/local/bin/ipfs-cluster-service`, `/usr/local/bin/ipfs-cluster-ctl` (on VM1)
  - **Requirements**: Req 1.1

- [ ] 3. Initialize ipfs-cluster on VM1 with CRDT consensus
  - Run `CLUSTER_SECRET=$CLUSTER_SECRET ipfs-cluster-service init --consensus crdt` as the `ipfs` service user
  - Confirm `~/.ipfs-cluster/service.json` is created
  - Record the peer ID printed during init (used as the bootstrap peer ID for VM2 and Local_Node)
  - **Files**: `~/.ipfs-cluster/service.json` (on VM1)
  - **Requirements**: Req 1.5

- [ ] 4. Configure service.json on VM1
  - Set `cluster.replication_factor_min` to `2` and `cluster.replication_factor_max` to `3`
  - Set `restapi.http_listen_multiaddress` to `/ip4/0.0.0.0/tcp/9094`
  - Set `restapi.basic_auth_credentials` to `"<CLUSTER_API_USER>:<CLUSTER_API_PASSWORD>"`
  - Verify `cluster.secret` matches the generated `CLUSTER_SECRET`
  - **Files**: `~/.ipfs-cluster/service.json` (on VM1)
  - **Requirements**: Req 2.1, Req 3.4, Req 7.1

- [ ] 5. Create systemd service file for ipfs-cluster on VM1
  - Create `/etc/systemd/system/ipfs-cluster.service` with `User=ipfs`, `EnvironmentFile=/etc/ipfs-cluster/env`, `ExecStart=/usr/local/bin/ipfs-cluster-service daemon`, `Restart=on-failure`, `After=ipfs.service`
  - Run `systemctl daemon-reload && systemctl enable ipfs-cluster`
  - **Files**: `/etc/systemd/system/ipfs-cluster.service` (on VM1)
  - **Requirements**: Req 1.2

- [ ] 6. Open GCP firewall ports 9094 and 9096 on VM1
  - Create or update a GCP firewall rule allowing TCP ingress on ports 9094 (REST API) and 9096 (cluster swarm) for VM1's network tag
  - Confirm both ports are reachable from VM2 and Local_Node external IPs
  - **Files**: GCP Console / `gcloud` firewall rule (infrastructure, no source files)
  - **Requirements**: Req 1.5, Req 3.1

- [ ] 7. Start and verify ipfs-cluster service on VM1; confirm peer ID
  - Run `systemctl start ipfs-cluster` and check `systemctl status ipfs-cluster` shows `active (running)`
  - Run `ipfs-cluster-ctl id` and record the full multiaddress `/ip4/104.198.148.182/tcp/9096/p2p/<PEER_ID>`
  - Confirm REST API responds: `curl -u user:pass http://104.198.148.182:9094/id`
  - **Files**: none (operational verification)
  - **Requirements**: Req 1.2, Req 1.5

---

## Phase 2 — VM2 Cluster Setup

- [ ] 8. Install ipfs-cluster-service on VM2
  - Repeat the same download, checksum verification, and binary installation steps from Task 2 on VM2
  - Confirm `ipfs-cluster-service --version` ≥ 1.0.6 on VM2
  - **Files**: `/usr/local/bin/ipfs-cluster-service`, `/usr/local/bin/ipfs-cluster-ctl` (on VM2)
  - **Requirements**: Req 1.1

- [ ] 9. Initialize ipfs-cluster on VM2 with bootstrap pointing to VM1
  - Set the same `CLUSTER_SECRET` env var on VM2 in `/etc/ipfs-cluster/env`
  - Run `CLUSTER_SECRET=$CLUSTER_SECRET ipfs-cluster-service init --consensus crdt`
  - Edit `~/.ipfs-cluster/service.json`: add VM1's multiaddress to `cluster.peer_addresses`
  - **Files**: `~/.ipfs-cluster/service.json`, `/etc/ipfs-cluster/env` (on VM2)
  - **Requirements**: Req 1.6, Req 1.7

- [ ] 10. Configure service.json on VM2
  - Set `cluster.replication_factor_min` to `2` and `cluster.replication_factor_max` to `3`
  - Set `restapi.http_listen_multiaddress` to `/ip4/0.0.0.0/tcp/9094`
  - Set `restapi.basic_auth_credentials` to the same credentials as VM1
  - Confirm `cluster.secret` matches the `CLUSTER_SECRET` on VM1
  - **Files**: `~/.ipfs-cluster/service.json` (on VM2)
  - **Requirements**: Req 2.1, Req 1.7, Req 7.1

- [ ] 11. Create systemd service file for ipfs-cluster on VM2
  - Create `/etc/systemd/system/ipfs-cluster.service` with the same unit definition as VM1
  - Run `systemctl daemon-reload && systemctl enable ipfs-cluster`
  - **Files**: `/etc/systemd/system/ipfs-cluster.service` (on VM2)
  - **Requirements**: Req 1.3

- [ ] 12. Open GCP firewall ports 9094 and 9096 on VM2
  - Create or update a GCP firewall rule for VM2's network tag to allow TCP ingress on ports 9094 and 9096
  - Confirm both ports are reachable from VM1 and Local_Node
  - **Files**: GCP Console / `gcloud` firewall rule (infrastructure)
  - **Requirements**: Req 1.6

- [ ] 13. Start VM2 cluster service and verify it joins the VM1 cluster
  - Run `systemctl start ipfs-cluster` on VM2
  - On VM1, run `ipfs-cluster-ctl peers ls` and confirm exactly 2 peers are listed (VM1 + VM2)
  - Verify peer join completes within 60 seconds of starting the service
  - **Files**: none (operational verification)
  - **Requirements**: Req 1.3, Req 1.6

---

## Phase 3 — Local Node Cluster Setup

- [ ] 14. Configure local IPFS repo path and storage quota
  - Identify the high-capacity storage volume mount point (e.g., `/Volumes/BigDisk`)
  - Set `IPFS_PATH` to point to a directory on that volume: `export IPFS_PATH=/Volumes/BigDisk/.ipfs`
  - Run `ipfs config Datastore.StorageMax "500GB"` (or edit `~/.ipfs/config` directly)
  - Confirm the setting with `ipfs config Datastore.StorageMax`
  - **Files**: `$IPFS_PATH/config` (on Local_Node)
  - **Requirements**: Req 6.1, Req 6.4

- [ ] 15. Install ipfs-cluster-service on Local Mac
  - Download the macOS (darwin/amd64 or arm64) release binary (≥ 1.0.6) from `dist.ipfs.tech`
  - Verify checksum and move binaries to `/usr/local/bin/`
  - Confirm `ipfs-cluster-service --version` ≥ 1.0.6
  - **Files**: `/usr/local/bin/ipfs-cluster-service`, `/usr/local/bin/ipfs-cluster-ctl` (on Local_Node)
  - **Requirements**: Req 1.1

- [ ] 16. Initialize ipfs-cluster on Local Mac with bootstrap to VM1
  - Set `CLUSTER_SECRET` in the local shell environment (e.g., `~/.zshrc` or a dedicated env file)
  - Run `CLUSTER_SECRET=$CLUSTER_SECRET ipfs-cluster-service init --consensus crdt`
  - Edit `~/.ipfs-cluster/service.json`: add VM1's full multiaddress to `cluster.peer_addresses`
  - **Files**: `~/.ipfs-cluster/service.json` (on Local_Node)
  - **Requirements**: Req 1.6, Req 1.7, Req 6.1

- [ ] 17. Configure service.json on Local Mac
  - Set `cluster.replication_factor_min` to `2` and `cluster.replication_factor_max` to `3`
  - Set `restapi.basic_auth_credentials` to the same credentials as VM1/VM2
  - Confirm `cluster.secret` matches the shared `CLUSTER_SECRET`
  - **Files**: `~/.ipfs-cluster/service.json` (on Local_Node)
  - **Requirements**: Req 2.1, Req 6.2, Req 6.3, Req 7.1

- [ ] 18. Create launchd plist for ipfs-cluster on macOS
  - Create `~/Library/LaunchAgents/io.ipfs.cluster.plist` with `ProgramArguments` pointing to `ipfs-cluster-service daemon`, `EnvironmentVariables` for `CLUSTER_SECRET` and `IPFS_PATH`, and `RunAtLoad` set to `true`
  - Run `launchctl load ~/Library/LaunchAgents/io.ipfs.cluster.plist`
  - **Files**: `~/Library/LaunchAgents/io.ipfs.cluster.plist` (on Local_Node)
  - **Requirements**: Req 1.4

- [ ] 19. Start local cluster and verify 3 peers are visible from VM1
  - Start the launchd service and confirm no errors in `~/Library/Logs/ipfs-cluster.log`
  - On VM1, run `ipfs-cluster-ctl peers ls` and confirm 3 peers are listed (VM1, VM2, Local_Node)
  - Verify the local peer appears as `"healthy"` within 60 seconds
  - **Files**: none (operational verification)
  - **Requirements**: Req 1.4, Req 1.6, Req 6.2, Req 6.3

---

## Phase 4 — Backend API Changes

- [ ] 20. Update `secure-share/ipfs-client.js`: add `clusterPin(cid)` with Basic auth and retry logic
  - Import `node-fetch` (or use the existing HTTP client) for making REST calls to the Cluster_API
  - Read `CLUSTER_API_URL`, `CLUSTER_API_USER`, `CLUSTER_API_PASSWORD` from `process.env`; log a warning and throw if any are missing at module load time
  - Implement `async function clusterPin(cid)` that sends `POST ${CLUSTER_API_URL}/pins/${cid}` with `Authorization: Basic <base64(user:pass)>` header
  - Implement retry loop: up to 3 attempts, catching network errors or non-2xx responses, waiting 5 seconds between attempts using `setTimeout`
  - On final failure, throw an `Error` with a descriptive message including the CID and HTTP status
  - Export `clusterPin` alongside the existing IPFS client exports
  - **Files**: `secure-share/ipfs-client.js`
  - **Requirements**: Req 3.1, Req 3.3, Req 3.4, Req 7.3, Req 7.4

- [ ] 21. Update `secure-share/index.js` `secureUpload`: call `clusterPin(cid)` after IPFS add
  - After the existing `ipfs.add(...)` call, retrieve the resulting CID string
  - Call `await clusterPin(cid)` immediately after a successful IPFS add
  - If `clusterPin` throws, propagate the error up to the caller without swallowing it
  - **Files**: `secure-share/index.js`
  - **Requirements**: Req 3.2

- [ ] 22. Update `index.js` `/api/upload` route: guard DB write on successful cluster pin
  - Wrap the `secureUpload` call in a try/catch block in the `/api/upload` handler
  - Only call the `FileRecord` database insert after `secureUpload` resolves successfully
  - If `secureUpload` rejects (including cluster pin failure), return `HTTP 503` with JSON body `{ "error": "IPFS cluster pin failed" }` and do not write to the database
  - **Files**: `index.js`
  - **Requirements**: Req 3.5, Req 3.6

- [ ] 23. Add cluster credentials to Render environment variables
  - In the Render dashboard, add `CLUSTER_API_URL` (e.g., `http://104.198.148.182:9094`), `CLUSTER_API_USER`, and `CLUSTER_API_PASSWORD` as environment variables for the backend service
  - Confirm the variables are not stored in `render.yaml` or any committed file
  - **Files**: `render.yaml` (verify no secrets are added here)
  - **Requirements**: Req 7.2, Req 7.4

- [ ] 24. Test upload flow end-to-end
  - Upload a test file through the API; confirm the response includes a CID and HTTP 200
  - On each of the 3 nodes, run `ipfs pin ls <CID>` and verify the CID is present
  - Confirm the `FileRecord` row exists in the database with the correct CID
  - Simulate cluster unavailability (stop `ipfs-cluster-service` on VM1) and confirm the API returns HTTP 503 with the expected error message
  - **Files**: none (manual/automated test)
  - **Requirements**: Req 3.2, Req 3.5, Req 3.6

---

## Phase 5 — GitHub Actions Workflow Updates

- [ ] 25. Update `health-check.yml`: add cluster health check step
  - Add a new job step that runs `curl -sf -u $CLUSTER_API_USER:$CLUSTER_API_PASSWORD $CLUSTER_API_URL/health/graph` and parses the JSON response
  - Count peers with `"status": "healthy"`; if the count is fewer than 2, trigger a Twilio SMS alert using the existing Twilio step pattern in the workflow
  - The Twilio SMS must be sent within 2 minutes of detecting the degraded state (keep the health-check schedule ≤ every 3 hours)
  - Also retain the existing `/api/health` HTTP 200 check in the same job
  - If either check fails, ensure the job exits with a non-zero code (`exit 1`)
  - Read `CLUSTER_API_URL`, `CLUSTER_API_USER`, `CLUSTER_API_PASSWORD` from GitHub Actions secrets
  - **Files**: `.github/workflows/health-check.yml`
  - **Requirements**: Req 4.1, Req 4.2, Req 4.3, Req 4.4, Req 4.5

- [ ] 26. Update `ipfs-mirror.yml`: replace SSH pin commands with Cluster API HTTP requests
  - Remove or disable any existing `ssh` steps that ran `ipfs pin add` directly on VM1
  - Add steps that loop over target CIDs and send `curl -sf -X POST -u $CLUSTER_API_USER:$CLUSTER_API_PASSWORD $CLUSTER_API_URL/pins/<CID>` for each CID
  - On non-2xx response, wait 30 seconds and retry once; if still failing, record the CID as failed but continue to the next CID (do not exit the loop)
  - After all CIDs are processed, fail the job if any CID failures were recorded
  - Add `CLUSTER_API_URL`, `CLUSTER_API_USER`, `CLUSTER_API_PASSWORD` to the workflow's `env` block sourced from GitHub Actions secrets
  - **Files**: `.github/workflows/ipfs-mirror.yml`
  - **Requirements**: Req 5.1, Req 5.2, Req 5.3, Req 5.4, Req 5.5

- [ ] 27. Update `gcp-ipfs-backup.yml`: manage ipfs-cluster lifecycle around snapshot
  - Before the existing VM stop step, add an SSH step to run `sudo systemctl stop ipfs-cluster` on VM1
  - After the existing VM start step, add an SSH step to run `sudo systemctl start ipfs-cluster` on VM1
  - Add a verification step: SSH to VM1 and run `systemctl is-active ipfs-cluster`; if the output is not `active`, trigger a Twilio SMS alert and exit with a non-zero code
  - **Files**: `.github/workflows/gcp-ipfs-backup.yml`
  - **Requirements**: Req 9.1, Req 9.2, Req 9.3, Req 9.4

- [ ] 28. Add new GitHub Actions secrets for cluster credentials
  - In the GitHub repository Settings → Secrets and variables → Actions, add:
    - `CLUSTER_API_URL` (e.g., `http://104.198.148.182:9094`)
    - `CLUSTER_API_USER`
    - `CLUSTER_API_PASSWORD`
  - Confirm that all three updated workflows reference these secrets by name and do not hardcode any values
  - **Files**: none (GitHub repository settings)
  - **Requirements**: Req 7.2, Req 5.4

- [ ] 29. Run all workflows manually and verify end-to-end
  - Trigger `health-check.yml` manually; confirm it detects 3 healthy peers and the backend health endpoint returns 200
  - Trigger `ipfs-mirror.yml` manually with a known CID; confirm the CID appears as pinned on all 3 nodes
  - Trigger `gcp-ipfs-backup.yml` manually; confirm the snapshot completes and `ipfs-cluster` restarts cleanly on VM1
  - Confirm all runs complete with green status in the GitHub Actions UI
  - **Files**: none (operational verification)
  - **Requirements**: Req 4.1, Req 5.1, Req 9.1, Req 9.3

---

## Phase 6 — Validation

- [ ] 30. Simulate VM2 offline: verify cluster degrades gracefully
  - Stop `ipfs-cluster-service` on VM2 (or stop the VM entirely)
  - Confirm VM1 and Local_Node continue to serve pinned CIDs via their local IPFS daemons
  - Within 5 minutes, confirm the cluster log on VM1 emits a degraded-pin alert for any CID that drops below `replication_factor_min`
  - Confirm the health-check workflow (when triggered) reports fewer than 3 healthy peers and would send the SMS alert
  - **Files**: none (operational validation)
  - **Requirements**: Req 2.3, Req 2.5, Req 4.2

- [ ] 31. Simulate Local_Node offline: verify minimum replication is maintained
  - Close laptop / stop `ipfs-cluster-service` on Local_Node
  - Confirm VM1 and VM2 continue to satisfy `replication_factor_min` = 2 for all pinned CIDs
  - Confirm no data unavailability occurs; upload a new file and verify it is pinned on both VM1 and VM2
  - Confirm the cluster does not count Local_Node toward `replication_factor_min`
  - **Files**: none (operational validation)
  - **Requirements**: Req 2.3, Req 6.3

- [ ] 32. Reconnect offline peer and verify automatic re-pinning
  - Bring the previously offline peer (VM2 or Local_Node) back online
  - Monitor `ipfs-cluster-ctl status` on VM1; confirm that within 10 minutes all previously missed CIDs are re-pinned on the rejoined peer
  - Verify the peer status transitions to `"healthy"` in `ipfs-cluster-ctl peers ls`
  - **Files**: none (operational validation)
  - **Requirements**: Req 2.4, Req 6.5
