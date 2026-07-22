# Requirements Document

## Introduction

This feature introduces a distributed IPFS Cluster across three nodes — VM1 (primary, us-central1-a), VM2 (backup/replication, us-east1-c), and a local Mac server (large-storage data backup) — to replace the current single-node IPFS setup. The cluster will coordinate CID pinning across all three nodes via IPFS Cluster, ensuring data redundancy so that content remains available if any single node goes down. The existing Node.js/Express backend (hosted on Render) continues to upload encrypted files through the `ipfs-client.js` module; only the target endpoint and cluster-awareness logic change. The hardcoded CID pinning workflow and snapshot-based backup workflows are upgraded to operate cluster-wide.

---

## Glossary

- **IPFS_Cluster**: The IPFS Cluster service (`ipfs-cluster-service` / `ipfs-cluster-ctl`) that coordinates pinning across member nodes.
- **Cluster_Peer**: An individual node participating in the IPFS Cluster (VM1, VM2, or Local_Node).
- **VM1**: The primary GCP VM (`instance-20260128-215242`, us-central1-a, IP 104.198.148.182). Runs both `ipfs` daemon and `ipfs-cluster-service` as the cluster leader/bootstrapper.
- **VM2**: The secondary GCP VM (`ipfs-node2-20260416-215755`, us-east1-c, IP 35.243.225.26). Runs both `ipfs` daemon and `ipfs-cluster-service` as a follower peer.
- **Local_Node**: The local Mac server with large storage. Runs both `ipfs` daemon and `ipfs-cluster-service` as a follower peer.
- **Backend_API**: The Node.js/Express application hosted on Render that handles file upload, encryption, and IPFS interaction.
- **ipfs_client**: The `secure-share/ipfs-client.js` module in the Backend_API that creates the `ipfs-http-client` connection.
- **Cluster_API**: The HTTP REST API exposed by `ipfs-cluster-service` (default port 9094) used to submit pin/unpin requests and query cluster state.
- **CID**: Content Identifier — the content-addressed hash IPFS assigns to stored data.
- **Replication_Factor**: The number of Cluster_Peers that must hold a pinned CID. Set to 3 (all nodes) for this system.
- **Pin_Queue**: The internal queue inside IPFS_Cluster that tracks pending and failed pin allocations.
- **Cluster_Secret**: A shared 32-byte hex secret that all Cluster_Peers must possess to join the cluster.
- **Snapshot**: A GCP disk snapshot of VM1's boot disk, used as a cold backup.
- **GitHub_Actions**: The CI/CD platform running the existing mirror, health-check, and backup workflows.

---

## Requirements

### Requirement 1: IPFS Cluster Installation and Bootstrapping

**User Story:** As a system operator, I want IPFS Cluster installed and running on all three nodes, so that I have a single coordinated cluster managing pin state across VM1, VM2, and the Local_Node.

#### Acceptance Criteria

1. THE IPFS_Cluster SHALL be installed (version ≥ 1.0.6) on VM1, VM2, and Local_Node.
2. THE IPFS_Cluster on VM1 SHALL run as a `systemd` service named `ipfs-cluster` and start automatically on system boot.
3. THE IPFS_Cluster on VM2 SHALL run as a `systemd` service named `ipfs-cluster` and start automatically on system boot.
4. WHEN the Local_Node restarts, THE IPFS_Cluster process on Local_Node SHALL restart automatically via a `launchd` plist or equivalent macOS service manager.
5. THE IPFS_Cluster on VM1 SHALL act as the bootstrap peer, exposing its `/ip4/<VM1_IP>/tcp/9096/p2p/<PEER_ID>` multiaddress for other peers to join.
6. WHEN VM2 or Local_Node starts `ipfs-cluster-service`, THE Cluster_Peer SHALL join the cluster by connecting to VM1's bootstrap multiaddress within 60 seconds.
7. THE Cluster_Secret SHALL be identical across all three Cluster_Peers; mismatched secrets SHALL cause the joining peer to be rejected with an authentication error.

---

### Requirement 2: Cluster Pin Replication Policy

**User Story:** As a system operator, I want every CID pinned through the cluster to be replicated on all three nodes, so that content remains available even if one node goes offline.

#### Acceptance Criteria

1. THE IPFS_Cluster SHALL be configured with a `replication_factor_min` of 2 and a `replication_factor_max` of 3 for all pin operations.
2. WHEN a CID is submitted to the Cluster_API for pinning, THE IPFS_Cluster SHALL allocate the pin to all available Cluster_Peers up to `replication_factor_max`.
3. WHILE a Cluster_Peer is offline, THE IPFS_Cluster SHALL maintain the pin on the remaining online peers and SHALL NOT remove existing pin allocations.
4. WHEN the offline Cluster_Peer reconnects, THE IPFS_Cluster SHALL automatically re-pin any CIDs that the peer missed during its downtime.
5. IF the number of peers holding a CID falls below `replication_factor_min`, THEN THE IPFS_Cluster SHALL emit a degraded-pin alert to the cluster log within 5 minutes.

---

### Requirement 3: Backend API Cluster Integration

**User Story:** As a backend developer, I want the Backend_API to submit pin requests through the IPFS_Cluster rather than directly to a single IPFS daemon, so that every uploaded file is automatically replicated across all nodes.

#### Acceptance Criteria

1. THE ipfs_client SHALL connect to the Cluster_API on VM1 at `http://<VM1_IP>:9094` using the `ipfs-cluster-ctl` HTTP REST interface or a compatible client library.
2. WHEN the Backend_API calls `secureUpload`, THE ipfs_client SHALL add the encrypted buffer to the IPFS daemon on VM1 and then submit a `POST /pins/<CID>` request to the Cluster_API.
3. IF the Cluster_API on VM1 is unreachable, THEN THE ipfs_client SHALL retry the pin request up to 3 times with a 5-second delay between attempts before returning an error to the caller.
4. THE ipfs_client SHALL authenticate Cluster_API requests using the `Authorization: Basic <base64(user:password)>` header, with credentials sourced from environment variables `CLUSTER_API_USER` and `CLUSTER_API_PASSWORD`.
5. THE Backend_API SHALL record the CID in the PostgreSQL database strictly only after receiving a successful `200` or `202` response from the Cluster_API pin endpoint; no recording SHALL occur if the Cluster_API returns any other response.
6. IF the Cluster_API returns a non-2xx response, THEN THE Backend_API SHALL return HTTP 503 to the uploading client with the message `"IPFS cluster pin failed"`.

---

### Requirement 4: Cluster Health Monitoring

**User Story:** As a system operator, I want automated health checks to verify that all three cluster peers are online and that the cluster is in a healthy state, so that I am alerted before data availability is compromised.

#### Acceptance Criteria

1. THE GitHub_Actions health-check workflow SHALL query the Cluster_API `GET /health/graph` endpoint on VM1 every 3 hours.
2. WHEN the `GET /health/graph` response indicates that fewer than 2 peers are `"healthy"`, THE GitHub_Actions workflow SHALL send an SMS alert via Twilio within 2 minutes of detecting the degraded state.
3. THE GitHub_Actions health-check workflow SHALL also verify that the existing `/api/health` backend endpoint returns HTTP 200 in the same scheduled run; database connection status is not required for this check to pass.
4. IF either the Cluster_API check or the backend health check fails, THEN THE GitHub_Actions workflow SHALL exit with a non-zero code, causing the run to be marked as failed.
5. THE Cluster_API health endpoint SHALL be protected by the same `Authorization: Basic` credentials as all other Cluster_API endpoints.

---

### Requirement 5: CID Mirror Workflow (Cluster-Wide Pinning)

**User Story:** As a system operator, I want the weekly CID mirror GitHub Actions workflow to pin CIDs through the cluster rather than SSHing into VM1 directly, so that all three nodes pin the specified CIDs consistently.

#### Acceptance Criteria

1. THE GitHub_Actions ipfs-mirror workflow SHALL replace its SSH-based `ipfs pin add` commands with HTTP `POST /pins/<CID>` requests to the Cluster_API on VM1.
2. WHEN the mirror workflow submits a pin request, THE IPFS_Cluster SHALL confirm allocation to all available peers; IF any Cluster_Peer is offline at the time of the request, THE GitHub_Actions workflow SHALL mark the step as failed.
3. IF a pin request returns a non-2xx response, THEN THE GitHub_Actions workflow SHALL retry the request once after 30 seconds before marking the step as failed.
4. THE GitHub_Actions workflow SHALL read the Cluster_API URL and credentials from GitHub Actions secrets (`CLUSTER_API_URL`, `CLUSTER_API_USER`, `CLUSTER_API_PASSWORD`).
5. THE GitHub_Actions workflow SHALL continue pinning remaining CIDs even if one CID fails, collecting all failures and reporting them at the end.

---

### Requirement 6: Local Node Data Backup Role

**User Story:** As a system operator, I want the Local_Node to serve as a large-storage backup that retains all pinned CIDs locally, so that a complete copy of the data exists outside of the GCP infrastructure.

#### Acceptance Criteria

1. THE Local_Node SHALL be configured as a Cluster_Peer with a dedicated IPFS repository path pointing to a high-capacity storage volume; IF `replication_factor_max` is configured to a value less than `replication_factor_min`, THEN THE IPFS_Cluster SHALL prevent the Local_Node from joining the cluster and SHALL log a configuration error.
2. THE IPFS_Cluster on Local_Node SHALL be allocated all pins (participates in `replication_factor_max` allocation), ensuring it holds a local copy of every CID.
3. WHILE the Local_Node is offline (e.g., laptop closed), THE IPFS_Cluster SHALL continue to operate using VM1 and VM2, satisfying `replication_factor_min` ≥ 2; the Local_Node SHALL NOT be counted toward `replication_factor_min` even when it is online.
4. THE Local_Node IPFS daemon SHALL be configured with a storage quota of at least 500 GB via the `Datastore.StorageMax` IPFS config key.
5. WHEN the Local_Node reconnects after an absence, THE IPFS_Cluster SHALL resume replicating any missed pins to the Local_Node within 10 minutes.

---

### Requirement 7: Cluster Secret and Credential Management

**User Story:** As a system operator, I want all cluster secrets and API credentials stored securely and not hardcoded in any source file, so that the cluster cannot be joined or queried by unauthorized parties.

#### Acceptance Criteria

1. THE Cluster_Secret SHALL be stored as an environment variable or in a secrets manager on each Cluster_Peer and SHALL NOT appear in any version-controlled file.
2. THE CLUSTER_API_USER and CLUSTER_API_PASSWORD credentials SHALL be stored as GitHub Actions secrets and as environment variables on the Backend_API (Render dashboard), and SHALL NOT be committed to the repository.
3. THE ipfs_client module SHALL read `CLUSTER_API_USER` and `CLUSTER_API_PASSWORD` exclusively from `process.env` at runtime.
4. IF any required credential environment variable (`CLUSTER_API_USER`, `CLUSTER_API_PASSWORD`, `CLUSTER_SECRET`) is missing at startup, THEN THE system SHALL log a warning message identifying the missing variable and refuse to start the affected service.

---

### Requirement 8: Graceful Peer Removal and Re-addition

**User Story:** As a system operator, I want to be able to remove a peer from the cluster for maintenance and re-add it without data loss, so that routine VM maintenance does not compromise data availability.

#### Acceptance Criteria

1. WHEN a Cluster_Peer is removed via `ipfs-cluster-ctl peers rm <PEER_ID>`, THE IPFS_Cluster SHALL redistribute the removed peer's pin allocations to the remaining peers within 5 minutes.
2. WHEN a new or re-initialized Cluster_Peer joins the cluster, THE IPFS_Cluster SHALL sync the full pin set to the new peer within 30 minutes for a dataset up to 50,000 CIDs.
3. IF a Cluster_Peer is removed while it holds the sole copy of any CID, THEN THE IPFS_Cluster SHALL log an error and refuse the removal unless the `--force` flag is explicitly passed, regardless of whether overall replication is currently below minimum.
4. THE IPFS_Cluster SHALL expose a `GET /peers` endpoint that lists all current peers, their IDs, multiaddresses, and status (`"healthy"` | `"offline"` | `"unknown"`).

---

### Requirement 9: Existing GCP Snapshot Backup Compatibility

**User Story:** As a system operator, I want the existing GCP disk snapshot workflow to continue operating correctly after IPFS Cluster is installed, so that a cold disk-level backup of VM1 still exists.

#### Acceptance Criteria

1. THE GitHub_Actions gcp-ipfs-backup workflow SHALL stop the `ipfs-cluster` systemd service on VM1 before stopping the VM instance, and restart it after the VM starts.
2. WHEN the VM restarts after a snapshot, THE ipfs-cluster service SHALL reconnect to VM2 and Local_Node within 60 seconds of the service starting.
3. THE gcp-ipfs-backup workflow SHALL verify that the `ipfs-cluster` service reports `active (running)` status on VM1; finding this active status SHALL automatically mark the workflow step as successful.
4. IF the `ipfs-cluster` service fails to start after the VM restarts, THEN THE GitHub_Actions workflow SHALL send an SMS alert via Twilio and exit with a non-zero code.
