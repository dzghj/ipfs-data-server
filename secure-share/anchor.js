// OpenTimestamps anchoring for file integrity hashes.
//
// A CID / a hash in our own database only proves "these bytes match this
// identifier" — a third party still has to trust our DB. OpenTimestamps writes
// a commitment to the file's SHA-256 into the Bitcoin blockchain (via free,
// aggregated calendar servers), producing a `.ots` proof that ANYONE can verify
// against Bitcoin without trusting us. That is what makes "anchored" honest.
//
// Flow:
//   1. anchorHash(sha256)  at upload → a *calendar commitment* (.ots), ~1 KB.
//   2. upgradeProof(.ots)  hours later → attaches the Bitcoin attestation.
//   3. verifyProof(.ots, sha256) → { verified, bitcoinTime } once confirmed.
//
// All calls are best-effort and time-bounded — a slow/broken calendar must
// never block or fail an upload (mirrors clusterPin()'s pattern).

import OpenTimestamps from "opentimestamps";

const { DetachedTimestampFile, Ops } = OpenTimestamps;

const OTS_TIMEOUT_MS = Number(process.env.OTS_TIMEOUT_MS || 8000);
const OTS_ENABLED = process.env.OTS_ENABLED !== "false"; // on by default

const sha256Op = () => new Ops.OpSHA256();

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function toDigest(sha256Hex) {
  const digest = Buffer.from(sha256Hex, "hex");
  if (digest.length !== 32) throw new Error("expected a 32-byte SHA-256 digest (hex)");
  return digest;
}

/**
 * Submit a SHA-256 digest (hex) to the OpenTimestamps calendars.
 * @returns {Promise<{ otsProof: string, anchoredAt: Date } | null>}
 *          otsProof is base64. null on any failure (non-fatal).
 */
export async function anchorHash(sha256Hex) {
  if (!OTS_ENABLED) return null;
  try {
    const detached = DetachedTimestampFile.fromHash(sha256Op(), toDigest(sha256Hex));
    await withTimeout(OpenTimestamps.stamp(detached), OTS_TIMEOUT_MS, "OTS stamp");
    return {
      otsProof: Buffer.from(detached.serializeToBytes()).toString("base64"),
      anchoredAt: new Date(),
    };
  } catch (err) {
    console.error("⚠️  OpenTimestamps stamp failed (non-fatal):", err.message);
    return null;
  }
}

/**
 * Try to attach the Bitcoin attestation to a calendar-only proof.
 * @returns {Promise<string | null>} a new base64 proof if it changed, else null.
 */
export async function upgradeProof(otsProofBase64) {
  try {
    const bytes = new Uint8Array(Buffer.from(otsProofBase64, "base64"));
    const detached = DetachedTimestampFile.deserialize(bytes);
    const changed = await withTimeout(
      OpenTimestamps.upgrade(detached),
      OTS_TIMEOUT_MS,
      "OTS upgrade"
    );
    if (!changed) return null;
    return Buffer.from(detached.serializeToBytes()).toString("base64");
  } catch (err) {
    console.error("⚠️  OpenTimestamps upgrade failed:", err.message);
    return null;
  }
}

/**
 * Verify a proof against a SHA-256 digest.
 * @returns {Promise<{ verified: boolean, pending: boolean, bitcoinTime: string|null, note: string }>}
 */
export async function verifyProof(otsProofBase64, sha256Hex) {
  try {
    const digest = toDigest(sha256Hex);
    const otsBytes = new Uint8Array(Buffer.from(otsProofBase64, "base64"));
    const detachedOts = DetachedTimestampFile.deserialize(otsBytes);
    const detachedFile = DetachedTimestampFile.fromHash(sha256Op(), digest);

    const result = await withTimeout(
      OpenTimestamps.verify(detachedOts, detachedFile),
      OTS_TIMEOUT_MS,
      "OTS verify"
    );

    // 0.4.x: {} while pending, or { bitcoin: { timestamp, height } } once confirmed.
    // Be liberal about the exact key.
    const att =
      result &&
      (result.bitcoin ||
        result.Bitcoin ||
        Object.values(result).find((v) => v && typeof v.timestamp === "number"));

    if (att && att.timestamp) {
      return {
        verified: true,
        pending: false,
        bitcoinTime: new Date(att.timestamp * 1000).toISOString(),
        blockHeight: att.height ?? null,
        note: "Confirmed in the Bitcoin blockchain",
      };
    }
    return {
      verified: false,
      pending: true,
      bitcoinTime: null,
      note: "Calendar commitment recorded; Bitcoin attestation not yet available (retry in a few hours).",
    };
  } catch (err) {
    return {
      verified: false,
      pending: true,
      bitcoinTime: null,
      note: `Verification error: ${err.message}`,
    };
  }
}
