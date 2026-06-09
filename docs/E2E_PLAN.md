
# End-to-End Test Plan — Pikorua Voice

## Goal

Exercise a full call lifecycle: create call record, add simulated conversation turns, trigger provider webhook to mark call completed, verify post-call processing (lead scoring, CRM sync log, call events).

## Quick start — automated runner

The fastest way to run this plan is the Node script at `tools/e2e/run-e2e.js`. It creates all required database rows, fires the webhook, waits for the worker, and prints a pass/fail summary.

```bash
# Prerequisites: API + worker running, Postgres + Redis up, .env configured.
node tools/e2e/run-e2e.js
```

The script requires the following env vars (read from `.env` automatically):

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/pikorua_voice` |
| `REDIS_URL` | `redis://localhost:6380` |
| `PUBLIC_BASE_URL` | `http://localhost:4100` |
| `API_AUTH_TOKEN` | _(any token set in .env)_ |

---

## Manual step-by-step

### Prerequisites

- Running services: API (`apps/api`), Worker (`apps/worker`), Postgres, Redis.
- `.env` configured with `DATABASE_URL`, `REDIS_URL`, `PUBLIC_BASE_URL`, and optionally `CRM_API_BASE_URL` (use `tools/e2e/mock-crm/server.js` as a local mock).
- `psql` CLI installed.

### Steps

**1. Insert campaign and target**

```sql
INSERT INTO campaigns (id, name, status, default_locale)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'E2E Test Campaign', 'active', 'hi-IN'
);

INSERT INTO campaign_targets (id, campaign_id, phone, full_name)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  '+911234567890', 'E2E Test Lead'
);
```

**2. Create a call row**

Replace `<SID>` with any unique string (e.g. `test-sid-001`).

```sql
INSERT INTO calls (
  id, campaign_id, target_id, crm_lead_id,
  provider_call_sid, status, from_number, to_number, locale
)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  NULL, 'test-sid-001', 'in_progress',
  '+911111111111', '+911234567890', 'hi-IN'
);
```

**3. Insert caller turns (simulates transcript)**

```sql
INSERT INTO call_turns (call_id, turn_index, role, content, locale) VALUES
('00000000-0000-0000-0000-000000000003', 0, 'caller',
 'Yes, I am interested and would like a demo today.', 'hi-IN'),
('00000000-0000-0000-0000-000000000003', 2, 'caller',
 'Please schedule a demo for tomorrow morning.', 'hi-IN');
```

**4. Fire the completed webhook**

```bash
curl -s -X POST http://localhost:4100/api/webhooks/exotel \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_AUTH_TOKEN" \
  -d '{"CallSid":"test-sid-001","CallStatus":"completed","ConversationDuration":"45"}'
```

**5. Wait for the worker (5 seconds is usually enough)**

```bash
sleep 5
```

**6. Assert outcomes**

```sql
-- Lead score should exist with label hot|warm|cold
SELECT score, label, timeline FROM lead_scores
WHERE call_id = '00000000-0000-0000-0000-000000000003';

-- CRM sync log should have an entry
SELECT sync_type, status, attempts FROM crm_sync_log
WHERE call_id = '00000000-0000-0000-0000-000000000003';

-- If label = 'hot', a hot_alert call event should exist
SELECT type, severity, message FROM call_events
WHERE call_id = '00000000-0000-0000-0000-000000000003';
```

### Expected outcomes

| Table | Expected |
|---|---|
| `lead_scores` | 1 row, `label` = `hot` (transcript contains "interested", "demo", "schedule") |
| `crm_sync_log` | 1 row, `status` = `success` or `skipped` (if CRM not configured) |
| `call_events` | 1 `hot_alert` row if label = `hot` |

---

## Cleanup

```sql
DELETE FROM campaigns WHERE id = '00000000-0000-0000-0000-000000000001';
```

Cascades delete targets, calls, turns, scores, CRM logs, and events.
