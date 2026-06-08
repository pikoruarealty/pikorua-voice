const { Client } = require('pg');
// Use global fetch (Node 18+). No external node-fetch dependency required.

if (!process.env.DATABASE_URL || !process.env.PUBLIC_BASE_URL) {
  console.error('Please set DATABASE_URL and PUBLIC_BASE_URL');
  process.exit(1);
}

const SID = `e2e-sid-${Date.now()}`;
const CALL_ID = '00000000-0000-0000-0000-000000000003';
const CAMPAIGN_ID = '00000000-0000-0000-0000-000000000001';
const TARGET_ID = '00000000-0000-0000-0000-000000000002';

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`INSERT INTO campaigns (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [CAMPAIGN_ID, 'E2E Test Campaign']);
  await client.query(`INSERT INTO campaign_targets (id, campaign_id, phone, full_name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [TARGET_ID, CAMPAIGN_ID, '+911234567890', 'E2E Target']);

  await client.query(`INSERT INTO calls (id, campaign_id, target_id, crm_lead_id, provider_call_sid, status, from_number, to_number, locale)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [CALL_ID, CAMPAIGN_ID, TARGET_ID, null, SID, 'in_progress', '+911111111111', '+911234567890', 'hi-IN']);

  await client.query(`INSERT INTO call_turns (call_id, turn_index, role, content, locale) VALUES
    ($1,0,'assistant',$2,'hi-IN'),($1,1,'assistant',$3,'hi-IN') ON CONFLICT DO NOTHING`, [CALL_ID, 'Yes, I am interested and would like a demo today.', 'Please schedule a demo for tomorrow morning.']);

  await client.end();

  console.log('Inserted test rows. Posting webhook...');

  const res = await fetch(`${process.env.PUBLIC_BASE_URL}/webhooks/exotel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CallSid: SID, CallStatus: 'completed' })
  });

  console.log('Webhook posted. Status:', res.status);
  console.log('Waiting 5s for worker processing...');
  await new Promise(r => setTimeout(r, 5000));

  const client2 = new Client({ connectionString: process.env.DATABASE_URL });
  await client2.connect();
  const lead = await client2.query(`SELECT id, call_id, score, label FROM lead_scores WHERE call_id = $1`, [CALL_ID]);
  console.log('lead_scores:', lead.rows);
  const crm = await client2.query(`SELECT id, call_id, status, attempts FROM crm_sync_log WHERE call_id = $1 ORDER BY created_at DESC`, [CALL_ID]);
  console.log('crm_sync_log:', crm.rows);
  await client2.end();
}

main().catch(err => { console.error(err); process.exit(1); });
