/**
 * Drives the REAL SttRouterService + REAL MetricsService against stub STT
 * providers — verifies the Flux/Nova-3 wiring end-to-end without any network:
 *   • correct provider chosen per locale + STT_FLUX_LOCALES
 *   • empty flag routes everything to Nova-3 (rollback)
 *   • session/failover counters emitted to metrics
 *   • Flux→Nova-3 connect-time failover swaps the active session and forwards
 *     subsequent audio to Nova-3
 *   • post-failover errors propagate to the caller
 *
 * Run with: pnpm build && node --test tools/tests/stt-router.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const { SttRouterService } = require("../../apps/api/dist/stt/stt-router.service");
const { MetricsService } = require("../../apps/api/dist/metrics/metrics.service");

const fakeConfig = (values) => ({ get: (k) => values[k] });

// A stub live-STT provider that records the sessions it opens and lets the test
// drive each session's callbacks + observe delegated audio.
function recordingProvider() {
  const sessions = [];
  return {
    sessions,
    openSession(locale, rate, callbacks) {
      const s = {
        locale,
        rate,
        callbacks,
        sent: [],
        closed: false,
        sendAudio: (c) => s.sent.push(c),
        clearBuffer: () => {},
        setEndpointing: () => {},
        close: () => {
          s.closed = true;
        },
      };
      sessions.push(s);
      return s;
    },
  };
}

const noopCallbacks = () => ({ onPartial() {}, onUtterance() {}, onError() {} });

test("routes enabled+eligible locale to Flux and counts the session", () => {
  const metrics = new MetricsService();
  const flux = recordingProvider();
  const dg = recordingProvider();
  const router = new SttRouterService(
    fakeConfig({ STT_FLUX_LOCALES: "en-IN,hi-IN" }),
    dg,
    flux,
    metrics,
  );

  const session = router.openSession("hi-IN", 8000, noopCallbacks(), {});
  assert.equal(flux.sessions.length, 1, "Flux session opened");
  assert.equal(dg.sessions.length, 0, "Nova-3 not opened");
  assert.match(metrics.renderPrometheus(), /pikorua_stt_sessions_total\{provider="flux"\} 1/);

  // Returned handle delegates audio to the active (Flux) session.
  session.sendAudio(Buffer.from([1, 2, 3]));
  assert.equal(flux.sessions[0].sent.length, 1);
});

test("routes non-eligible locale (Gujarati) to Nova-3", () => {
  const metrics = new MetricsService();
  const flux = recordingProvider();
  const dg = recordingProvider();
  const router = new SttRouterService(
    fakeConfig({ STT_FLUX_LOCALES: "en-IN,hi-IN" }),
    dg,
    flux,
    metrics,
  );

  router.openSession("gu-IN", 8000, noopCallbacks(), {});
  assert.equal(dg.sessions.length, 1);
  assert.equal(flux.sessions.length, 0);
  assert.match(metrics.renderPrometheus(), /pikorua_stt_sessions_total\{provider="nova-3"\} 1/);
});

test("empty STT_FLUX_LOCALES routes every locale to Nova-3 (rollback)", () => {
  const metrics = new MetricsService();
  const flux = recordingProvider();
  const dg = recordingProvider();
  const router = new SttRouterService(fakeConfig({ STT_FLUX_LOCALES: "" }), dg, flux, metrics);

  for (const loc of ["en-IN", "hi-IN", "gu-IN"]) {
    router.openSession(loc, 8000, noopCallbacks(), {});
  }
  assert.equal(flux.sessions.length, 0, "Flux never opened when flag empty");
  assert.equal(dg.sessions.length, 3);
});

test("Flux permanent failure fails over to Nova-3 and forwards audio there", () => {
  const metrics = new MetricsService();
  const flux = recordingProvider();
  const dg = recordingProvider();
  const callerErrors = [];
  const callbacks = { onPartial() {}, onUtterance() {}, onError: (m) => callerErrors.push(m) };
  const router = new SttRouterService(
    fakeConfig({ STT_FLUX_LOCALES: "hi-IN" }),
    dg,
    flux,
    metrics,
  );

  const session = router.openSession("hi-IN", 8000, callbacks, {});
  assert.equal(flux.sessions.length, 1);

  // Flux socket dies permanently → router should fail over silently.
  flux.sessions[0].callbacks.onError("flux socket dead");
  assert.equal(flux.sessions[0].closed, true, "failed Flux session closed");
  assert.equal(dg.sessions.length, 1, "Nova-3 fallback opened");
  assert.equal(callerErrors.length, 0, "caller NOT notified — failover is transparent");
  assert.match(
    metrics.renderPrometheus(),
    /pikorua_stt_failover_total\{from="flux",to="nova-3"\} 1/,
  );

  // Audio now flows to the Nova-3 session, not the dead Flux one.
  session.sendAudio(Buffer.from([9]));
  assert.equal(dg.sessions[0].sent.length, 1);
  assert.equal(flux.sessions[0].sent.length, 0);

  // A subsequent error from the fallback DOES reach the caller.
  dg.sessions[0].callbacks.onError("nova-3 also failed");
  assert.deepEqual(callerErrors, ["nova-3 also failed"]);
});
