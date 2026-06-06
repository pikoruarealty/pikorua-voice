-- Initial schema for Pikorua Voice
-- Generated migration: create enums, tables, indexes, and update triggers

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaign_status') THEN
        CREATE TYPE campaign_status AS ENUM ('draft','active','paused','completed','archived');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dial_status') THEN
        CREATE TYPE dial_status AS ENUM ('pending','queued','dialing','in_progress','completed','no_answer','busy','failed','voicemail','do_not_call','exhausted');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_direction') THEN
        CREATE TYPE call_direction AS ENUM ('outbound','inbound');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_status') THEN
        CREATE TYPE call_status AS ENUM ('queued','initiated','ringing','in_progress','completed','no_answer','busy','failed','canceled');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'turn_role') THEN
        CREATE TYPE turn_role AS ENUM ('caller','assistant','system');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'score_label') THEN
        CREATE TYPE score_label AS ENUM ('hot','warm','cold');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_timeline') THEN
        CREATE TYPE lead_timeline AS ENUM ('immediate','short_term','long_term','exploring','unknown');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_sync_type') THEN
        CREATE TYPE crm_sync_type AS ENUM ('create_lead','update_lead','add_note','update_status');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_sync_status') THEN
        CREATE TYPE crm_sync_status AS ENUM ('pending','success','failed','skipped');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_event_type') THEN
        CREATE TYPE call_event_type AS ENUM ('escalation','hot_alert','consultant_transfer','guardrail_block','fallback_used','dnc_requested','worker_failure');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_severity') THEN
        CREATE TYPE event_severity AS ENUM ('info','warning','critical');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'webhook_status') THEN
        CREATE TYPE webhook_status AS ENUM ('received','processed','failed','ignored');
    END IF;
END $$;

-- Helper: updated_at trigger
CREATE OR REPLACE FUNCTION pikorua_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  status campaign_status NOT NULL DEFAULT 'draft',
  source varchar(80),
  default_locale varchar(16) NOT NULL DEFAULT 'en-IN',
  script_ref varchar(120) NOT NULL DEFAULT 'default',
  dial_window_start varchar(5),
  dial_window_end varchar(5),
  max_attempts smallint NOT NULL DEFAULT 3,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns(status);
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION pikorua_set_updated_at();

-- campaign_targets
CREATE TABLE IF NOT EXISTS campaign_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  crm_lead_id varchar(120),
  full_name varchar(200),
  phone varchar(32) NOT NULL,
  locale varchar(16),
  dial_status dial_status NOT NULL DEFAULT 'pending',
  attempts smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 3,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_targets_campaign_idx ON campaign_targets(campaign_id);
CREATE INDEX IF NOT EXISTS campaign_targets_dial_status_idx ON campaign_targets(dial_status);
CREATE INDEX IF NOT EXISTS campaign_targets_next_attempt_idx ON campaign_targets(next_attempt_at);
ALTER TABLE campaign_targets ADD CONSTRAINT IF NOT EXISTS campaign_targets_campaign_phone_uq UNIQUE (campaign_id, phone);
CREATE TRIGGER campaign_targets_updated_at BEFORE UPDATE ON campaign_targets FOR EACH ROW EXECUTE FUNCTION pikorua_set_updated_at();

-- calls
CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  target_id uuid REFERENCES campaign_targets(id) ON DELETE SET NULL,
  crm_lead_id varchar(120),
  provider_call_sid varchar(120),
  direction call_direction NOT NULL DEFAULT 'outbound',
  status call_status NOT NULL DEFAULT 'queued',
  from_number varchar(32),
  to_number varchar(32),
  locale varchar(16),
  queued_at timestamptz NOT NULL DEFAULT now(),
  initiated_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  recording_url text,
  hangup_cause varchar(80),
  transferred_to varchar(32),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE calls ADD CONSTRAINT IF NOT EXISTS calls_provider_call_sid_uq UNIQUE (provider_call_sid);
CREATE INDEX IF NOT EXISTS calls_campaign_idx ON calls(campaign_id);
CREATE INDEX IF NOT EXISTS calls_target_idx ON calls(target_id);
CREATE INDEX IF NOT EXISTS calls_status_idx ON calls(status);
CREATE TRIGGER calls_updated_at BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION pikorua_set_updated_at();

-- call_turns
CREATE TABLE IF NOT EXISTS call_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  turn_index integer NOT NULL,
  role turn_role NOT NULL,
  content text NOT NULL,
  locale varchar(16),
  stt_ms integer,
  llm_ms integer,
  tts_ms integer,
  total_ms integer,
  llm_model varchar(80),
  prompt_tokens integer,
  completion_tokens integer,
  guardrail_triggered boolean NOT NULL DEFAULT false,
  guardrail_rule varchar(80),
  fallback_used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_turns_call_idx ON call_turns(call_id);
ALTER TABLE call_turns ADD CONSTRAINT IF NOT EXISTS call_turns_call_turn_uq UNIQUE (call_id, turn_index);

-- lead_scores
CREATE TABLE IF NOT EXISTS lead_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  crm_lead_id varchar(120),
  score smallint NOT NULL,
  label score_label NOT NULL,
  rationale text,
  signals jsonb,
  timeline lead_timeline NOT NULL DEFAULT 'unknown',
  override_label score_label,
  override_reason text,
  override_by varchar(120),
  override_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_scores ADD CONSTRAINT IF NOT EXISTS lead_scores_call_uq UNIQUE (call_id);
CREATE INDEX IF NOT EXISTS lead_scores_label_idx ON lead_scores(label);
ALTER TABLE lead_scores ADD CONSTRAINT IF NOT EXISTS lead_scores_score_range CHECK (score >= 0 AND score <= 100);
CREATE TRIGGER lead_scores_updated_at BEFORE UPDATE ON lead_scores FOR EACH ROW EXECUTE FUNCTION pikorua_set_updated_at();

-- crm_sync_log
CREATE TABLE IF NOT EXISTS crm_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES calls(id) ON DELETE CASCADE,
  crm_lead_id varchar(120),
  sync_type crm_sync_type NOT NULL,
  status crm_sync_status NOT NULL DEFAULT 'pending',
  http_status integer,
  attempts smallint NOT NULL DEFAULT 0,
  request_payload jsonb,
  response_payload jsonb,
  error text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_sync_log_call_idx ON crm_sync_log(call_id);
CREATE INDEX IF NOT EXISTS crm_sync_log_status_idx ON crm_sync_log(status);
CREATE TRIGGER crm_sync_log_updated_at BEFORE UPDATE ON crm_sync_log FOR EACH ROW EXECUTE FUNCTION pikorua_set_updated_at();

-- call_events
CREATE TABLE IF NOT EXISTS call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES calls(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  type call_event_type NOT NULL,
  severity event_severity NOT NULL DEFAULT 'info',
  message text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_events_call_idx ON call_events(call_id);
CREATE INDEX IF NOT EXISTS call_events_type_idx ON call_events(type);

-- webhook_events
CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(40) NOT NULL DEFAULT 'exotel',
  event_type varchar(80),
  provider_call_sid varchar(120),
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  signature_valid boolean NOT NULL DEFAULT false,
  status webhook_status NOT NULL DEFAULT 'received',
  raw_payload jsonb,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS webhook_events_sid_idx ON webhook_events(provider_call_sid);
CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events(status);

-- Done
