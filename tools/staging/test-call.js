/**
 * One-shot test call via Exotel API.
 * Mirrors dial.service.ts payload exactly.
 *
 * Usage:
 *   node tools/staging/test-call.js <toNumber>
 *   node tools/staging/test-call.js 9427620852
 */
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function main() {
  loadEnv();

  const toNumber = process.argv[2];
  if (!toNumber) throw new Error("Usage: node tools/staging/test-call.js <toNumber>");

  const sid = process.env.EXOTEL_SID;
  const key = process.env.EXOTEL_API_KEY;
  const token = process.env.EXOTEL_API_TOKEN;
  const subdomain = process.env.EXOTEL_SUBDOMAIN ?? "api.exotel.com";
  const callerId = process.env.EXOTEL_CALLER_ID;
  const appId = process.env.EXOTEL_APP_ID;
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

  if (!sid || !key || !token) throw new Error("EXOTEL_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN not set");
  if (!callerId) throw new Error("EXOTEL_CALLER_ID not set");

  const params = new URLSearchParams({
    From: callerId,
    To: toNumber,
    CallerId: callerId,
  });
  if (appId) params.set("AppId", appId);
  if (publicBaseUrl) {
    params.set("StatusCallback", `${publicBaseUrl}/api/webhooks/exotel`);
    params.set("StatusCallbackContentType", "application/json");
    params.append("StatusCallbackEvents[]", "answered");
    params.append("StatusCallbackEvents[]", "terminal");
  }

  const url = `https://${subdomain}/v1/Accounts/${sid}/Calls/connect.json`;
  console.log(`Placing call: ${callerId} → ${toNumber}`);
  console.log(`Exotel URL:   ${url}`);
  console.log(`App ID:       ${appId ?? "(none)"}`);
  console.log(`Callback:     ${publicBaseUrl ? publicBaseUrl + "/api/webhooks/exotel" : "(none)"}`);
  console.log("");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${key}:${token}`).toString("base64")}`,
    },
    body: params.toString(),
  });

  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }

  console.log(`Status: ${res.status} ${res.statusText}`);
  console.log(JSON.stringify(parsed, null, 2));

  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
