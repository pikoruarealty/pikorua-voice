/**
 * CRM /call-results request contract.
 *
 * Mirrors the spec the CRM team gave us:
 *
 *   POST https://crm.pikoruarealty.com/api/v1/voice/call-results
 *   Content-Type: application/json
 *   Authorization: Bearer <VOICE_API_BEARER_TOKEN>
 *   X-Timestamp: <current ISO timestamp>
 *   X-Signature: sha256=<HMAC-SHA256 of exact JSON body>
 *   Idempotency-Key: <value-containing-callId>
 *
 * These assertions run the REAL signing code, then verify it the way the CRM does.
 * A drift here is invisible locally (the mock CRM accepts anything) and shows up in
 * production as a 403 on every lead.
 *
 * Run with: node --test tools/tests/crm-contract.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createHmac } = require("node:crypto");
const path = require("node:path");

const dist = (rel) => require(path.resolve(__dirname, "../../apps/worker/dist/postcall", rel));
const { buildCrmHeaders } = dist("crm-signing.js");
const { crmCallResultsUrl } = dist("crm-client.js");

const SECRET = "test-hmac-secret";
const TOKEN = "test-bearer-token";
const CALL_ID = "9a0e2705-afaf-4385-a45d-7d8baf37db80";
// Includes Gujarati + Devanagari: the payload really does carry both (score signals
// quote the caller), and multi-byte content is where naive HMAC/encoding breaks.
const PAYLOAD = { callId: CALL_ID, score: { label: "warm", note: "આપણે બજેટ — तीन बजे" } };

test("the endpoint URL is the base plus /call-results", () => {
  assert.equal(
    crmCallResultsUrl("https://crm.pikoruarealty.com/api/v1/voice"),
    "https://crm.pikoruarealty.com/api/v1/voice/call-results",
  );
  // A trailing slash on the base must not double up.
  assert.equal(
    crmCallResultsUrl("https://crm.pikoruarealty.com/api/v1/voice/"),
    "https://crm.pikoruarealty.com/api/v1/voice/call-results",
  );
});

test("headers match the CRM contract exactly", () => {
  const rawBody = JSON.stringify(PAYLOAD);
  const headers = buildCrmHeaders(rawBody, {
    bearerToken: TOKEN,
    hmacSecret: SECRET,
    idempotencyKey: `pikorua:create_lead:${CALL_ID}`,
  });

  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);

  // X-Timestamp must be a parseable ISO-8601 instant, not epoch millis.
  assert.match(headers["X-Timestamp"], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(Number.isFinite(Date.parse(headers["X-Timestamp"])));

  // Idempotency-Key must contain the callId — the CRM dedupes on it.
  assert.ok(headers["Idempotency-Key"].includes(CALL_ID));
});

// Verify the signature the way the CRM does: recompute the HMAC over the exact body
// bytes and compare. This is the assertion that would catch a change to the digest
// encoding, the prefix, or what the signature covers.
test("X-Signature is sha256=<hex HMAC of the exact JSON body>", () => {
  const rawBody = JSON.stringify(PAYLOAD);
  const headers = buildCrmHeaders(rawBody, { hmacSecret: SECRET });

  const [scheme, hex] = headers["X-Signature"].split("=");
  assert.equal(scheme, "sha256", "the CRM expects a sha256= prefix");
  assert.match(hex, /^[0-9a-f]{64}$/, "lowercase hex digest");

  const expected = createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex");
  assert.equal(hex, expected, "signature must cover the exact body, UTF-8 encoded");

  // The signature covers the BODY ONLY — not the timestamp. Signing
  // `timestamp + "." + body` (a stronger scheme) would 403 against this CRM until
  // they change their verifier too. See the SECURITY NOTE in crm-signing.ts.
  const withTimestamp = createHmac("sha256", SECRET)
    .update(`${headers["X-Timestamp"]}.${rawBody}`, "utf8")
    .digest("hex");
  assert.notEqual(hex, withTimestamp);
});

// Any mutation of the body must invalidate the signature — proves the assertion
// above is actually checking something.
test("a modified body does not verify against the signature", () => {
  const rawBody = JSON.stringify(PAYLOAD);
  const headers = buildCrmHeaders(rawBody, { hmacSecret: SECRET });
  const sent = headers["X-Signature"].split("=")[1];

  const tampered = JSON.stringify({ ...PAYLOAD, score: { label: "hot" } });
  const recomputed = createHmac("sha256", SECRET).update(tampered, "utf8").digest("hex");
  assert.notEqual(sent, recomputed);
});
