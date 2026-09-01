# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Express/Postgres backend for LegacyChain, a blockchain-secured document vault: users upload files, they're encrypted and pinned to an IPFS cluster, and nominees can be granted access to a deceased/incapacitated user's files. See [README.md](./README.md) for the two documented endpoints (health probe, resend-check cron) and Render cron setup. This repo is deployed to Render (see `render.yaml`) and also drives several scheduled GitHub Actions workflows that monitor the IPFS cluster VMs and this backend itself.

## Commands

```bash
npm install
npm start          # node index.js
npm run dev         # nodemon index.js
npm run cron        # node cron-runner.js — standalone script Render's cron service runs hourly

npm test                                    # node --test tests/*.test.js
node --test tests/monitoring.test.js        # run a single test file
node --test --test-name-pattern="<name>" tests/monitoring.test.js   # run a single test case
```

Only `tests/monitoring.test.js` exists (Node's built-in `node:test`, no Jest/Mocha) — it covers `monitoring.js`'s pure functions only. No route/DB/IPFS integration tests exist.

No `.env.example` exists in this repo — check with the team for required values before running locally. **`.env`'s `INTERNAL_SECRET` does not match what the code reads (`process.env.INTERNAL_API_SECRET`, see `monitoring.js`)** — as checked in, internal endpoints (`/api/internal/github-event`, `/api/internal/run-resend-check`) will reject every request locally until that's renamed to `INTERNAL_API_SECRET` (Render's own env config already uses the correct name via `render.yaml`, so production isn't affected).

## Architecture

**`routes/*.js` is dead code — do not edit it expecting effect.** `index.js` only mounts `authRoutes` from `auth.js` (at `/api/auth`); every other endpoint (uploads, file view/download, nominees, folders, checkin, AI risk scoring, plans) is implemented directly inline in `index.js`, duplicating (and in some cases diverging from) what's in `routes/ai.js`, `routes/checkin.js`, `routes/files.js`, `routes/folders.js`, `routes/nominees.js`, `routes/plans.js`. Those files read like an attempted Router-based refactor that was never wired in with `app.use()`. Notably, `routes/files.js` has nominee E2E-key-wrapping endpoints (`/api/file/:id/download-encrypted`, `/api/file/:id/nominee-key`, backed by `secure-share/user-keys.js` RSA wrapping) that **don't exist in the live app at all**. Before touching any route, check whether the real handler is in `index.js`, not the matching `routes/` file.

**Encryption model** (`secure-share/`): each uploaded file gets its own random AES-256-GCM key (`crypto-utils.js`'s `generateKey()`), encrypted client-content is uploaded to IPFS via `ipfs-client.js` (HTTP RPC API, `ipfs-http-client`, pointed at `IPFS_HOST`/`IPFS_PORT` with an `X-Secret-Key` header), and the file's own AES key is stored in plaintext (base64) in `FileRecord.encryptionKey`/`iv`/`authTag` in Postgres — there's no envelope encryption of the per-file key itself (the `FILE_ENCRYPTION_KEY` env var exists but nothing reads it). `secureView()` only lets `user.id === file.userId` decrypt; `secureUpload()` also best-effort replicates the pin across the cluster via a local `clusterPin()` helper that logs and swallows failures rather than hard-failing — this is weaker than what `.kiro/specs/.../design.md` specifies (that doc wants 3 retries then a hard 503), worth reconciling if cluster-pin reliability becomes an issue.

**Nominee schema drift — three sources of truth disagree.** The `Nominee` Sequelize model (`db.js`) does not declare `nomineeAccountId`/`publicKey`, but `index.js`'s live nominee-access routes and the orphaned `routes/nominees.js`/`routes/files.js` read/write those fields anyway (only survives because `sequelize.sync()` runs in non-production and the actual dev DB likely has stale/out-of-band columns). Separately, `migrations/001_create_nominee_access_sends.sql`'s column set (`sentAt`, no `ownerId`/`openedAt`) doesn't match the `NomineeAccessSend` model (`lastSentAt`, `ownerId`, `openedAt`) — don't assume that migration file reflects the real table shape in any deployed DB. If you touch nominee code, reconcile the model against whatever the target Postgres instance actually has before trusting either the model or the migration file.

**No Sequelize associations are declared** — all relationships (`User`↔`FileRecord`, `User`↔`Nominee`, `Folder`↔`FileRecord` via a free-text `category` string, not an FK) are plain integer/string columns joined manually in route code, not `belongsTo`/`hasMany`.

**Scheduled jobs, two overlapping systems:**
- Render's own `resend-cron` service (`render.yaml`, hourly) runs `cron-runner.js` → `POST /api/internal/run-resend-check`.
- GitHub Actions (`.github/workflows/*.yml`) independently also hits `nominee-resend.yml` → the same endpoint, plus separate workflows for `health-check`, `cluster-health`, `ai-health-check`, `ipfs-mirror`, `gcp-ipfs-backup` that aren't represented in `render.yaml` at all — they poll the backend/VMs directly and forward results to `/api/internal/github-event`, which `notifyAgent.js`'s `forwardGithubEvent()` relays to the separate `ipfs-AI-control` agent (Tailscale-only, can't be reached directly from GitHub's runners). If you're debugging a duplicate-alert or missed-alert issue around nominee resends, check both cron paths, not just one.

**Root-level `fix-*.py`/`setup-*.sh`/`update-bootstrap.py`/`com.ipfs.cluster.plist`** are local-only, gitignored ops scripts for patching IPFS Cluster config directly on VM1/VM2/the Mac Mini (bootstrap peers, listen addrs) — not part of the deployed app, not run in CI. `cron-runner.js` is the one root script that *is* part of the app (Render's cron entrypoint).

**`.kiro/specs/ipfs-cluster-distributed-storage/`** has real design docs (`requirements.md`, `design.md`, `tasks.md`) for the 3-node IPFS Cluster topology (port map: 4001 swarm, 5001 IPFS RPC, 9094 Cluster REST, 9096 cluster swarm) and the intended retry/hard-fail behavior for cluster pinning. IPs referenced there are stale (VM1's IP changed since) but the architectural intent still applies — read it before making cluster-pinning or multi-node changes.

**Auth**: JWT via `jsonwebtoken`, secret is `process.env.JWT_SECRET || "supersecret"` (`auth.js`) — the hardcoded fallback is a real risk if `JWT_SECRET` is ever unset in a deployed environment. `notifyAgent({type:"user_login",...})` fires (fire-and-forget) only on successful login in `auth.js`; the `/api/upload` route in `index.js` separately fires `file_upload` and `error` events the same way (see `ipfs-AI-control`'s CLAUDE.md for the receiving side).

**Vestigial dependencies**: `ethers`, `web3.storage`, `nodemailer`, and `twilio` are either in `package.json` or referenced by `.env` var names with no actual call sites in the current code (`resend` is what's actually used for email; nothing sends SMS despite Twilio env vars existing) — don't assume a feature exists just because its dependency or env var is present.
