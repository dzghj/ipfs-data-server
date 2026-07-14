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
      } else {
        console.error(`Cron job failed: ${res.statusCode}`);
        console.error(data);
        process.exit(1);
      }
    });
  }
);

req.on("error", (error) => {
  console.error("Cron job request failed:", error);
  process.exit(1);
});

req.end();
