// Minimal PayPal REST (Orders v2) client — no SDK dependency, Node 18+'s
// built-in fetch is enough. Defaults to the sandbox API so this can't
// accidentally take real payments before PAYPAL_API_BASE is deliberately
// pointed at the live endpoint.
//
// Required env vars (none of these exist yet — set them in Render's
// dashboard, and locally in .env, before this is usable):
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
//   PAYPAL_API_BASE   (defaults to https://api-m.sandbox.paypal.com;
//                      use https://api-m.paypal.com for real/live payments)

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are not configured");
  }

  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || "PayPal auth failed");

  cachedToken = data.access_token;
  // Refresh a minute early rather than cutting it exactly at expiry.
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// customId round-trips through PayPal untouched and comes back on capture —
// that's what lets captureOrder() below recover which user/plan an order
// was for without trusting anything the client sends at capture time.
export async function createOrder({ amount, currency = "USD", customId }) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        custom_id: customId,
        amount: { currency_code: currency, value: amount.toFixed(2) },
      }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "PayPal order creation failed");
  return data; // { id, status, ... }
}

export async function captureOrder(orderId) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "PayPal capture failed");
  return data; // { id, status, purchase_units: [{ custom_id, ... }], ... }
}
