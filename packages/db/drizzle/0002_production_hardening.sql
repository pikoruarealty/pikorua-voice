-- Production hardening fields for idempotency and retry safety.

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS event_key varchar(160);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_key_uq
  ON webhook_events(event_key);

ALTER TABLE crm_sync_log
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(160);

CREATE UNIQUE INDEX IF NOT EXISTS crm_sync_log_idempotency_key_uq
  ON crm_sync_log(idempotency_key);
