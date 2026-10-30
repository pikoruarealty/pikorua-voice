/**
 * Operator pages (demo + /status) are password-protected, and the status
 * dashboard turns vendor failures into readable rows.
 *
 * Run with: pnpm build && node --test tools/tests/status-dashboard.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

const { operatorPagesGuard, isOperatorPage } = require("../../apps/api/dist/auth/operator-pages.guard");

function run(guard, path, auth) {
  const res = { code: 200, headers: {}, body: "", status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; } };
  let passed = false;
  guard({ path, headers: auth ? { authorization: auth } : {} }, res, () => (passed = true));
  return { passed, res };
}
const basic = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

test("the demo, its token endpoint and the dashboard need the password", () => {
  const guard = operatorPagesGuard("s3cret", true);
  for (const path of ["/", "/status", "/api/status", "/api/demo/session"]) {
    assert.equal(run(guard, path).passed, false, `${path} must not be open`);
    assert.equal(run(guard, path).res.code, 401);
    assert.match(run(guard, path).res.headers["WWW-Authenticate"], /^Basic /, "browser shows a login box");
    assert.equal(run(guard, path, basic("x", "wrong")).passed, false);
    assert.equal(run(guard, path, basic("anyone", "s3cret")).passed, true);
  }
});

test("Exotel, CRM and health routes are never behind the dashboard password", () => {
  const guard = operatorPagesGuard("s3cret", true);
  for (const path of ["/api/health", "/api/webhooks/exotel", "/exotel-stream", "/api/metrics", "/api/campaigns"]) {
    assert.equal(isOperatorPage(path), false, path);
    assert.equal(run(guard, path).passed, true, `${path} must be untouched`);
  }
});

test("production without DASHBOARD_PASSWORD disables the pages instead of opening them", () => {
  const prod = run(operatorPagesGuard("", true), "/api/demo/session");
  assert.equal(prod.passed, false);
  assert.equal(prod.res.code, 503);
  assert.equal(run(operatorPagesGuard("", false), "/").passed, true, "local dev stays open");
});

test("vendor failures show the vendor's own reason (e.g. Sarvam out of credit)", async () => {
  // A local fake vendor: Sarvam-style 403 with its error message.
  const server = http.createServer((req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No credits available." } }));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const axios = require(require.resolve("axios", { paths: [require("path").resolve(__dirname, "../../apps/api")] }));
  const { StatusService } = require("../../apps/api/dist/status/status.service");
  const svc = Object.create(StatusService.prototype);
  svc.config = { get: (k) => ({ SARVAM_API_KEY: "sk" })[k] };
  svc.tts = { sarvamBreakerOpenForMs: () => 0 };
  const realPost = axios.post;
  axios.post = (_url, body, opts) => realPost(`http://127.0.0.1:${port}/`, body, opts);
  try {
    const row = await svc.sarvam();
    assert.equal(row.level, "error");
    assert.match(row.detail, /No credits available\./);
  } finally {
    axios.post = realPost;
    server.close();
  }
});
