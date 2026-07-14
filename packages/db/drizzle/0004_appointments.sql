-- Site-visit appointments (features #2 reconfirmation + #4 post-visit feedback).
-- Additive only: no existing table is altered. The reminder/feedback schedulers
-- fire relative to scheduled_at. Pricing/inventory are never stored here.

-- Enum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status') THEN
        CREATE TYPE appointment_status AS ENUM ('scheduled','confirmed','rescheduled','cancelled','completed','no_show');
    END IF;
END $$;

-- Table
CREATE TABLE IF NOT EXISTS appointments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
    campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    crm_lead_id varchar(120),
    full_name varchar(200),
    phone varchar(32) NOT NULL,
    locale varchar(16),
    scheduled_at timestamptz NOT NULL,
    status appointment_status NOT NULL DEFAULT 'scheduled',
    source varchar(16) NOT NULL DEFAULT 'auto',
    confirmed boolean NOT NULL DEFAULT false,
    reminder_t24_at timestamptz,
    reminder_t2_at timestamptz,
    feedback_call_at timestamptz,
    outcome text,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointments_phone_idx ON appointments(phone);
CREATE INDEX IF NOT EXISTS appointments_scheduled_at_idx ON appointments(scheduled_at);
CREATE INDEX IF NOT EXISTS appointments_status_idx ON appointments(status);
CREATE INDEX IF NOT EXISTS appointments_call_idx ON appointments(call_id);

-- Keep updated_at fresh (mirrors the trigger pattern used by other tables in 0001).
DROP TRIGGER IF EXISTS appointments_updated_at ON appointments;
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION pikorua_set_updated_at();
