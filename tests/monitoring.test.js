import test from "node:test";
import assert from "node:assert/strict";

import { buildHealthPayload, isAuthorizedInternalRequest } from "../monitoring.js";

test("accepts a matching internal secret header", () => {
  const req = { get: (name) => (name === "x-internal-secret" ? "shared-secret" : undefined) };
  assert.equal(isAuthorizedInternalRequest(req, "shared-secret"), true);
  assert.equal(isAuthorizedInternalRequest(req, "different-secret"), false);
});

test("builds a degraded health payload when the database is unavailable", () => {
  const payload = buildHealthPayload({ status: "error", db: "disconnected", uptime: 12, timestamp: "2026-07-13T00:00:00.000Z" });

  assert.equal(payload.status, "error");
  assert.equal(payload.db, "disconnected");
  assert.equal(payload.uptime, 12);
  assert.equal(payload.timestamp, "2026-07-13T00:00:00.000Z");
});
