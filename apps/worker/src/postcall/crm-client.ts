import axios, { type AxiosResponse } from "axios";
import { buildCrmHeaders, type CrmAuthOptions } from "./crm-signing";

const REQUEST_TIMEOUT_MS = 5000;

/** Full URL of the CRM's call-result ingestion endpoint. */
export function crmCallResultsUrl(crmBase: string): string {
  return `${crmBase.replace(/\/$/, "")}/call-results`;
}

/**
 * POST a call-result payload to the CRM.
 *
 * The payload is serialized once here and both signed and transmitted as that
 * exact string, guaranteeing the HMAC covers the bytes actually sent (see
 * {@link buildCrmHeaders}). Used by the post-call path and the retry worker so
 * signing/serialization stay identical.
 */
export function postCallResult(
  crmBase: string,
  payload: unknown,
  opts: CrmAuthOptions,
): Promise<AxiosResponse> {
  const rawBody = JSON.stringify(payload);
  const headers = buildCrmHeaders(rawBody, opts);
  return axios.post(crmCallResultsUrl(crmBase), rawBody, {
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  });
}
