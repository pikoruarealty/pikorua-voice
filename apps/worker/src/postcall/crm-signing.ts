import { createHmac } from "node:crypto";

export interface CrmAuthOptions {
  bearerToken?: string;
  hmacSecret?: string;
  idempotencyKey?: string;
}

/**
 * Build the request headers for a Voice→CRM call.
 *
 * The CRM validates `X-Signature` as an HMAC-SHA256 over the RAW request body
 * (lowercase hex, `sha256=` prefixed) and rejects requests whose `X-Timestamp`
 * is outside its allowed clock skew (±300s by default). The signature covers the
 * body only — the timestamp is a separate anti-replay check — so the caller MUST
 * transmit exactly the `rawBody` string passed here and never let the HTTP client
 * re-serialize the payload, or the signature will not match.
 *
 * When `hmacSecret` is blank the request is sent unsigned (useful for local dev
 * against a mock); a real CRM will reject it with 403.
 *
 * SECURITY NOTE (integration contract): the signature covers ONLY the body, not
 * `X-Timestamp` or `Idempotency-Key`. An attacker who captures one signed request
 * can therefore replay it as a NEW lead by rewriting those two unsigned headers —
 * a fresh timestamp clears the CRM's skew window and a new idempotency key evades
 * dedup, while the body-only signature still validates. This matches the CRM's
 * agreed scheme, so fully closing it requires a CHANGE ON THE CRM SIDE (sign over
 * `timestamp + "." + body`); do not unilaterally change signing here or every
 * request will 403. Tracked for the CRM team.
 */
export function buildCrmHeaders(rawBody: string, opts: CrmAuthOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (opts.bearerToken) {
    headers.Authorization = `Bearer ${opts.bearerToken}`;
  }
  if (opts.idempotencyKey) {
    headers["Idempotency-Key"] = opts.idempotencyKey;
  }
  if (opts.hmacSecret) {
    const signature = createHmac("sha256", opts.hmacSecret).update(rawBody, "utf8").digest("hex");
    headers["X-Signature"] = `sha256=${signature}`;
    // Fresh per request (including retries) so it always lands inside the CRM's
    // clock-skew window.
    headers["X-Timestamp"] = new Date().toISOString();
  }

  return headers;
}
