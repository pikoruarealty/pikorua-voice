# End-to-End Test Plan — Pikorua Voice

Goal
----
Exercise a full call lifecycle: create call record, add simulated conversation turns, trigger provider webhook to mark call completed, verify post-call processing (lead scoring, CRM sync log, call events).

Prerequisites
-------------
- Running services: API (`apps/api`), Worker (`apps/worker`), Postgres, Redis.
- `.env` configured with `DATABASE_URL`, `REDIS_URL`, `PUBLIC_BASE_URL`, and `CRM_API_BASE_URL` (can be a local mock).
- `psql` CLI installed and reachable for convenience (alternatively run SQL via your DB client).

High-level steps
----------------
1. Insert a test `campaign` and `campaign_target` (optional).
2. Create a `call` row with a unique `provider_call_sid`.
3. Insert `call_turns` rows to simulate STT/LLM assistant content (the transcript used by scoring).
4. POST an Exotel-like webhook to the API webhook endpoint with `CallSid` equal to the `provider_call_sid` and `CallStatus=completed`.
5. Wait a few seconds for the worker to process the queued `postcall` job.
6. Query `lead_scores`, `crm_sync_log`, and `call_events` to assert expected outcomes.

SQL templates
-------------
-- Create campaign (optional)
INSERT INTO campaigns (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'E2E Test Campaign');

-- Create target (optional)
INSERT INTO campaign_targets (id, campaign_id, phone, full_name) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','+911234567890','E2E Test');

-- Create call with providerCallSid
-- Replace <SID> with a test value
INSERT INTO calls (id, campaign_id, target_id, crm_lead_id, provider_call_sid, status, from_number, to_number, locale)
VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002', NULL, '<SID>', 'in_progress', '+911111111111', '+911234567890', 'hi-IN');

-- Insert call turns (assistant replies) used for scoring
INSERT INTO call_turns (call_id, turn_index, role, content, locale) VALUES
('00000000-0000-0000-0000-000000000003', 0, 'assistant', 'Yes, I am interested and would like a demo today.', 'hi-IN'),
('00000000-0000-0000-0000-000000000003', 1, 'assistant', 'Please schedule a demo for tomorrow morning.', 'hi-IN');

Assertions
----------
- `lead_scores` should contain a row for the call id with label `hot|warm|cold` depending on heuristics.
- `crm_sync_log` should have an entry for the call id with status `success|failed|skipped`.
- If `hot`, `call_events` should include a `hot_alert` for the call.

Notes
-----
- The included `tools/e2e/run-e2e.sh` is a helper scaffold to run these steps using `psql` and `curl`. Adjust IDs and environment accordingly.
