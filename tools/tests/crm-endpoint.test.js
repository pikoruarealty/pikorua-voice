/**
 * CRM ingestion endpoint invariants.
 *
 * CRM sync is deliberately non-fatal — a call completes normally whether or not the
 * lead reaches the CRM. That makes a misconfigured URL invisible on the voice path:
 * every call sounds perfect and no lead is ever delivered.
 *
 * Run with: node --test tools/tests/crm-endpoint.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

// The path is appended in code, so every configured value must be a BASE. A value
// carrying "/call-results" produces ".../call-results/call-results" → 404 on every
// sync, with nothing on the voice path to show for it.
test("configured CRM base URLs never include the /call-results path", () => {
  const client = read("apps/worker/src/postcall/crm-client.ts");
  assert.ok(
    client.includes('}/call-results`'),
    "crm-client must append /call-results to the configured base",
  );

  for (const file of ["render.yaml", ".env.example"]) {
    const src = read(file);
    for (const line of src.split(/\r?\n/)) {
      // Only assignments, not the explanatory comments (which name the full URL).
      const m = line.match(/^\s*(?:-\s*key:\s*CRM_API_BASE_URL|CRM_API_BASE_URL\s*=\s*(.+))/);
      const valueLine = line.match(/^\s*value:\s*(\S+)/);
      const assigned = m?.[1] ?? (/^\s*value:/.test(line) ? valueLine?.[1] : undefined);
      if (!assigned) continue;
      const url = assigned.replace(/^["']|["']$/g, "");
      if (!/^https?:\/\//.test(url)) continue;
      assert.ok(
        !url.includes("/call-results"),
        `${file}: CRM_API_BASE_URL must be the base, not the full endpoint (got ${url})`,
      );
    }
  }
});

// The production base must be the real CRM, not a placeholder or localhost — the
// worker only warns about this AFTER a sync has already failed.
test("render.yaml pins the production CRM base (not localhost or a placeholder)", () => {
  const src = read("render.yaml");
  const bases = [...src.matchAll(/key:\s*CRM_API_BASE_URL\s*\n\s*value:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(bases.length > 0, "render.yaml must set CRM_API_BASE_URL by value, not sync:false");
  for (const base of bases) {
    assert.match(base, /^https:\/\//, `CRM base must be https (got ${base})`);
    assert.ok(!/localhost|127\.0\.0\.1|example\.com|<.*>/.test(base), `placeholder base: ${base}`);
  }
});
