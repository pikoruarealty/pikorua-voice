-- Reconcile idempotency indexes with schema.ts.
--
-- 0002 created these as FULL unique indexes, but schema.ts declares them as
-- PARTIAL (WHERE <col> IS NOT NULL). The two definitions drift, so drizzle-kit
-- would keep proposing a "fix" migration. Recreate them as partial to match the
-- source of truth. (Functionally equivalent for dedup — Postgres already treats
-- NULLs as distinct — this only removes the drift.)

DROP INDEX IF EXISTS webhook_events_event_key_uq;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_key_uq
  ON webhook_events(event_key)
  WHERE event_key IS NOT NULL;

DROP INDEX IF EXISTS crm_sync_log_idempotency_key_uq;
CREATE UNIQUE INDEX IF NOT EXISTS crm_sync_log_idempotency_key_uq
  ON crm_sync_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
