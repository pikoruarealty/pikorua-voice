/**
 * Inbound AGC waveform continuity.
 * Run with: pnpm build && node --test tools/tests/inbound-agc.test.js
 *
 * WHY THIS EXISTS. The AGC is the ONLY thing that modifies caller audio before it
 * reaches Deepgram, and it has already garbled STT once: an early version hard-clamped
 * boosted peaks, flat-topping them into square waves ("Four" heard as "Ford").
 *
 * The second instance of the same class of bug: gain was computed per frame but
 * applied as a CONSTANT across that frame, with a near-instant attack. A quiet frame
 * followed by a loud one changed the multiplier by several x AT the frame boundary —
 * a step discontinuity, i.e. a click, up to 50 times a second on 20 ms frames. That is
 * broadband energy an ASR reads as consonants, and it is the shape of a clean Hindi
 * sentence coming back as "La cucinattima bat corona?".
 *
 * The gain now ramps across each frame. These tests assert waveform CONTINUITY, which
 * is the property that matters, rather than any particular gain curve.
 *
 * NOTE ON MEASUREMENT: do not measure raw sample-to-sample deltas. Those scale with
 * the gain itself, so a working AGC "fails" — the first attempt at this test made
 * exactly that mistake. Recover the per-sample gain (out/in) and measure ITS
 * discontinuity, which isolates the artifact from the signal.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const SR = 8000;
const FRAME = 320; // 20 ms @ 8 kHz, 16-bit mono — Exotel's alignment unit

function loadAgc() {
  const src = fs.readFileSync("apps/api/dist/call-runtime/exotel-voicebot.gateway.js", "utf8");
  const consts = [...src.matchAll(/const (INBOUND_AGC_\w+) = ([^;]+);/g)].map((m) => m[0]).join("\n");
  const agcNumber = src.match(/function agcNumber\([\s\S]*?\n\}/);
  const cls = src.match(/class InboundAgc \{[\s\S]*?\n\}/);
  assert.ok(agcNumber && cls, "could not lift InboundAgc out of the compiled gateway");
  // eslint-disable-next-line no-new-func
  return new Function(`${agcNumber[0]}\n${consts}\n${cls[0]}\nreturn InboundAgc;`)();
}

// Inharmonic mix so frame boundaries never land on a fixed phase (a single tone whose
// period divides the frame length hides boundary artifacts entirely), with an abrupt
// quiet/loud envelope to force the gain to move.
function speechLike(seconds, peakAmp) {
  const n = SR * seconds;
  const buf = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t % 0.7 < 0.35 ? 0.15 : 1.0;
    const v =
      (Math.sin(2 * Math.PI * 317 * t) +
        0.6 * Math.sin(2 * Math.PI * 823 * t) +
        0.3 * Math.sin(2 * Math.PI * 1471 * t)) *
      env * peakAmp * 0.5;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return buf;
}

function run(signal) {
  const Agc = loadAgc();
  const agc = new Agc();
  const out = [];
  for (let off = 0; off + FRAME <= signal.length; off += FRAME) {
    out.push(Buffer.from(agc.process(signal.subarray(off, off + FRAME))));
  }
  return Buffer.concat(out);
}

// Largest jump in the recovered per-sample gain at a frame boundary.
function boundaryGainJump(input, output) {
  const n = output.length >> 1;
  const samplesPerFrame = FRAME >> 1;
  let worst = 0;
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const inS = input.readInt16LE(i * 2);
    const g = Math.abs(inS) > 200 ? output.readInt16LE(i * 2) / inS : NaN;
    if (i % samplesPerFrame === 0 && Number.isFinite(g) && Number.isFinite(prev)) {
      worst = Math.max(worst, Math.abs(g - prev));
    }
    prev = g;
  }
  return worst;
}

test("a boosted quiet caller gets no gain step at frame boundaries", () => {
  // The AGC's actual purpose: a soft talker who needs real gain. This is where the
  // per-frame step was worst relative to the signal, and where it must now vanish.
  for (const peak of [900, 2500]) {
    const sig = speechLike(2, peak);
    const jump = boundaryGainJump(sig, run(sig));
    assert.ok(
      jump < 0.1,
      `quiet caller (peak ${peak}): gain jumps ${jump.toFixed(2)}x at a frame boundary — ` +
        `the gain must ramp across the frame, not step between frames`,
    );
  }
});

test("the AGC never clips, at any input level", () => {
  // Clipping is the other way this component has garbled STT: flat-topped peaks are
  // square waves, and a square wave is broadband noise to an ASR.
  for (const peak of [500, 2500, 9000, 20000, 32000]) {
    const sig = speechLike(1, peak);
    const out = run(sig);
    for (let i = 0; i < out.length >> 1; i++) {
      const v = out.readInt16LE(i * 2);
      assert.ok(
        v > -32768 && v < 32767,
        `peak ${peak}: output hit the rail at sample ${i} (${v}) — boosted audio must never clip`,
      );
    }
  }
});

test("a quiet caller is actually made louder (the AGC still does its job)", () => {
  // Continuity is worthless if the fix silently disabled the boost.
  const sig = speechLike(2, 900);
  const out = run(sig);
  const rms = (buf) => {
    let sumSq = 0;
    const n = buf.length >> 1;
    for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sumSq += s * s; }
    return Math.sqrt(sumSq / n);
  };
  assert.ok(rms(out) > rms(sig) * 2, "a very quiet caller must still be boosted substantially");
});

test("near-silence is not amplified into phantom speech", () => {
  // Line hiss boosted 12x becomes something an ASR will happily invent words from.
  const n = SR;
  const hiss = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) hiss.writeInt16LE(Math.round((Math.random() - 0.5) * 40), i * 2);
  const out = run(hiss);
  let maxAbs = 0;
  for (let i = 0; i < out.length >> 1; i++) maxAbs = Math.max(maxAbs, Math.abs(out.readInt16LE(i * 2)));
  assert.ok(maxAbs < 200, `hiss was amplified to ${maxAbs} — the noise gate must hold it near unity`);
});
