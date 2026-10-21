import http from "node:http";
import https from "node:https";

const targetUrl = process.env.CRON_TARGET_URL;
const secret = process.env.INTERNAL_API_SECRET;

if (!targetUrl || !secret) {
  console.error("CRON_TARGET_URL and INTERNAL_API_SECRET must be set");
  process.exit(1);
}

const parsedUrl = new URL(targetUrl);
const requester = parsedUrl.protocol === "https:" ? https : http;

// This runs hourly via Render's cron service — a single transient failure
// (cold start, brief Postgres hiccup) used to silently drop that hour's run
// with no retry, visible only in Render's own job log. 3 attempts with a
// fixed delay is plenty for an hourly job; a 4xx is a config/auth problem
// retrying won't fix, so those fail immediately instead of wasting retries.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

function attempt(attemptNum) {
  const req = requester.request(
    targetUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
    },
    (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`Cron job succeeded: ${res.statusCode}`);
          console.log(data);
          return;
        }
        if (res.statusCode && res.statusCode < 500) {
          console.error(`Cron job failed (non-retryable): ${res.statusCode}`);
          console.error(data);
          process.exit(1);
        }
        retryOrFail(attemptNum, `HTTP ${res.statusCode}: ${data}`);
      });
    }
  );

  req.on("error", (error) => retryOrFail(attemptNum, error.message));
  req.end();
}

function retryOrFail(attemptNum, reason) {
  if (attemptNum >= MAX_ATTEMPTS) {
    console.error(`Cron job failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
    process.exit(1);
  }
  console.warn(`Cron job attempt ${attemptNum} failed (${reason}) — retrying in ${RETRY_DELAY_MS / 1000}s...`);
  setTimeout(() => attempt(attemptNum + 1), RETRY_DELAY_MS);
}

attempt(1);
