const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// Use global fetch (Node 18+). No external node-fetch dependency required.

if (!process.env.DATABASE_URL || !process.env.PUBLIC_BASE_URL) {
  console.error("Please set DATABASE_URL and PUBLIC_BASE_URL");
  process.exit(1);
}

const SID = `e2e-sid-${Date.now()}`;
const CALL_ID = crypto.randomUUID();
const CAMPAIGN_ID = crypto.randomUUID();
const TARGET_ID = crypto.randomUUID();

async function main() {
  const psql = (sql) => {
    execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-d", process.env.DATABASE_URL, "-c", sql], {
      stdio: "inherit",
    });
  };

  psql(
    `INSERT INTO campaigns (id, name) VALUES ('${CAMPAIGN_ID}', 'E2E Test Campaign') ON CONFLICT DO NOTHING;`,
  );
  psql(
    `INSERT INTO campaign_targets (id, campaign_id, phone, full_name) VALUES ('${TARGET_ID}', '${CAMPAIGN_ID}', '+911234567890', 'E2E Target') ON CONFLICT DO NOTHING;`,
  );
  psql(`INSERT INTO calls (id, campaign_id, target_id, crm_lead_id, provider_call_sid, status, from_number, to_number, locale)
    VALUES ('${CALL_ID}','${CAMPAIGN_ID}','${TARGET_ID}',NULL,'${SID}','in_progress','+911111111111','+911234567890','hi-IN') ON CONFLICT DO NOTHING;`);
  psql(`INSERT INTO call_turns (call_id, turn_index, role, content, locale) VALUES
    ('${CALL_ID}',0,'caller','Yes, I am interested and would like a demo today.','hi-IN'),
    ('${CALL_ID}',1,'caller','Please schedule a demo for tomorrow morning.','hi-IN') ON CONFLICT DO NOTHING;`);

  console.log("Inserted test rows. Posting webhook...");

  const res = await fetch(`${process.env.PUBLIC_BASE_URL}/api/webhooks/exotel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ CallSid: SID, CallStatus: "completed" }),
  });

  console.log("Webhook posted. Status:", res.status);
  console.log("Waiting 5s for worker processing...");
  await new Promise((r) => setTimeout(r, 5000));

  const lead = execFileSync(
    "psql",
    [
      "-At",
      "-d",
      process.env.DATABASE_URL,
      "-c",
      `SELECT id, call_id, score, label FROM lead_scores WHERE call_id = '${CALL_ID}';`,
    ],
    { encoding: "utf8" },
  );
  console.log("lead_scores:\n" + lead.trim());

  const crm = execFileSync(
    "psql",
    [
      "-At",
      "-d",
      process.env.DATABASE_URL,
      "-c",
      `SELECT id, call_id, status, attempts FROM crm_sync_log WHERE call_id = '${CALL_ID}' ORDER BY created_at DESC;`,
    ],
    { encoding: "utf8" },
  );
  console.log("crm_sync_log:\n" + crm.trim());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
