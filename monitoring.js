export function isAuthorizedInternalRequest(req, secret) {
  if (!secret) return false;
  const provided = req.get?.("x-internal-secret") || req.headers?.["x-internal-secret"];
  return provided === secret;
}

export function buildHealthPayload({ status = "ok", db = "connected", uptime = 0, timestamp = new Date().toISOString() }) {
  return {
    status,
    db,
    uptime,
    timestamp,
  };
}
