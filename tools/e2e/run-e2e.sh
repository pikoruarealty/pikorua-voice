#!/usr/bin/env bash
set -euo pipefail

# Run a lightweight end-to-end scenario using psql and curl.
# Requires: DATABASE_URL, PUBLIC_BASE_URL, psql in PATH, and API running.

SID="e2e-sid-$(date +%s)"
CALL_ID="00000000-0000-0000-0000-000000000003"
CAMPAIGN_ID="00000000-0000-0000-0000-000000000001"
TARGET_ID="00000000-0000-0000-0000-000000000002"

echo "Using SID=${SID}"

cat <<SQL | psql "$DATABASE_URL"
-- create campaign
INSERT INTO campaigns (id, name) VALUES ('$CAMPAIGN_ID', 'E2E Test Campaign') ON CONFLICT DO NOTHING;
-- create target
INSERT INTO campaign_targets (id, campaign_id, phone, full_name) VALUES ('$TARGET_ID', '$CAMPAIGN_ID', '+911234567890', 'E2E Target') ON CONFLICT DO NOTHING;
-- create call
INSERT INTO calls (id, campaign_id, target_id, crm_lead_id, provider_call_sid, status, from_number, to_number, locale)
VALUES ('$CALL_ID', '$CAMPAIGN_ID', '$TARGET_ID', NULL, '$SID', 'in_progress', '+911111111111', '+911234567890', 'hi-IN') ON CONFLICT DO NOTHING;
-- insert call turns
INSERT INTO call_turns (call_id, turn_index, role, content, locale) VALUES
('$CALL_ID', 0, 'assistant', 'Yes, I am interested and would like a demo today.', 'hi-IN'),
('$CALL_ID', 1, 'assistant', 'Please schedule a demo for tomorrow morning.', 'hi-IN') ON CONFLICT DO NOTHING;
SQL

echo "Inserted test rows. Posting webhook to API to mark call completed..."

curl -s -X POST "$PUBLIC_BASE_URL/webhooks/exotel" \
  -H "Content-Type: application/json" \
  -d '{"CallSid":"'"$SID"'","CallStatus":"completed"}'

echo "Webhook posted. Waiting 5s for worker processing..."
sleep 5

echo "Checking lead_scores and crm_sync_log..."
psql "$DATABASE_URL" -c "SELECT id, call_id, score, label FROM lead_scores WHERE call_id = '$CALL_ID';"
psql "$DATABASE_URL" -c "SELECT id, call_id, status, attempts FROM crm_sync_log WHERE call_id = '$CALL_ID' ORDER BY created_at DESC;"

echo "Done."
