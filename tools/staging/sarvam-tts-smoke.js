/**
 * Sarvam Bulbul TTS smoke + latency spike.
 *
 * RESULT (2026-07-17, bulbul:v3, gu-IN @ 8000):
 *   Format ✔ — WAV, 8000 Hz, mono, 16-bit, 44-byte header, parts=1. Exactly
 *   Exotel's wire format; stripWavHeader handles it, no resampling needed.
 *   Latency ✖ — 2.2-4.2s per sentence (REST synthesizes the whole clip before
 *   responding). ElevenLabs is ~200-400ms. TOO SLOW for the live path.
 *
 * CONSEQUENCE: the live per-sentence path uses the WEBSOCKET instead
 * (SarvamService.synthesizeStream → ~235ms to first audio). See
 * sarvam-ws-smoke.js. The REST endpoint this script exercises is still used for
 * getClip/prewarmClips, which are warmed at call start and so not
 * latency-critical — that is why this script is still worth keeping.
 *
 * Answers the three questions that gate Gujarati going live:
 *   1. TTFB / total latency per sentence — the turn pipeline assumes ~200-400ms
 *      per sentence from ElevenLabs. If Sarvam is far slower, the Gujarati call
 *      will feel sluggish and the design needs to change (WS/HTTP streaming).
 *   2. Audio format — is the response WAV-wrapped or raw PCM? At what sample
 *      rate? Exotel needs raw s16le 8kHz. A stray 44-byte RIFF header is audible
 *      noise, not silence.
 *   3. Does gu-IN + 8000 Hz actually get accepted?
 *
 * Usage:
 *   SARVAM_API_KEY=... node tools/staging/sarvam-tts-smoke.js
 *   (also reads SARVAM_API_KEY / SARVAM_SPEAKER / SARVAM_MODEL from .env)
 *
 * Writes the decoded PCM to tools/staging/out/ so you can actually LISTEN to it —
 * the voice choice for Maya is a human decision, not a passing assertion.
 */
const fs = require("node:fs");
const path = require("node:path");

const URL = "https://api.sarvam.ai/text-to-speech";
const OUT_DIR = path.join(__dirname, "out");

function loadEnv() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Mirrors stripWavHeader in apps/api/src/tts/sarvam.service.ts. Duplicated on
// purpose: this script must be runnable without building the workspace.
function inspectWav(buf) {
  if (buf.length < 12) return { container: "unknown", pcm: buf };
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { container: "raw-pcm", pcm: buf };
  }
  const info = { container: "wav" };
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      info.audioFormat = buf.readUInt16LE(offset + 8);
      info.channels = buf.readUInt16LE(offset + 10);
      info.sampleRate = buf.readUInt32LE(offset + 12);
      info.bitsPerSample = buf.readUInt16LE(offset + 22);
    }
    if (id === "data") {
      info.headerBytes = offset + 8;
      info.pcm = buf.subarray(offset + 8, Math.min(offset + 8 + size, buf.length));
      return info;
    }
    offset += 8 + size + (size % 2);
  }
  info.pcm = buf;
  return info;
}

// Female speakers available for bulbul:v3 (the API rejects the rest with a
// helpful list). Maya is a 28-year-old woman, so the male voices — aditya,
// ashutosh, rahul, rohan, amit, dev, ratan, varun, manan, sumit, kabir, aayan,
// shubh, advait, anand, tarun — are not candidates.
const FEMALE_SPEAKERS = [
  "ritu",
  "priya",
  "neha",
  "pooja",
  "simran",
  "kavya",
  "ishita",
  "shreya",
  "roopa",
  "tanya",
];

// Representative Gujarati lines from Maya's actual script — including the
// code-switched English she really says, since that is the hard part.
const SAMPLES = [
  {
    label: "greeting (long, code-switched)",
    text: "Hello, હું Maya બોલી રહી છું પિકોરા Group તરફથી. તમારી enquiry મળી હતી, તો તમને personally invite કરવા માંગતી હતી.",
  },
  {
    label: "short ack (latency-critical)",
    text: "Perfect. તમે roughly કયા budget માં comfortable છો?",
  },
  {
    label: "pitch (numbers + English terms)",
    text: "અમારું એક curated 5 BHK residence સિંધુ ભવન રોડ પર છે — Ready to Move In, approx five thousand two hundred સ્ક્વેર ફીટ.",
  },
];

async function synth(text, speaker, model) {
  const body = {
    text,
    target_language_code: "gu-IN",
    speaker,
    model,
    speech_sample_rate: 8000,
    pace: 1.0,
  };
  const start = Date.now();
  const resp = await fetch(URL, {
    method: "POST",
    headers: {
      "api-subscription-key": process.env.SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const ttfb = Date.now() - start;
  if (!resp.ok) {
    const detail = await resp.text();
    return { ok: false, status: resp.status, detail: detail.slice(0, 300), ttfb };
  }
  const json = await resp.json();
  const total = Date.now() - start;
  if (!Array.isArray(json.audios) || !json.audios.length) {
    return { ok: false, status: resp.status, detail: "no audios[] in response", ttfb };
  }
  const raw = Buffer.from(json.audios[0], "base64");
  return { ok: true, ttfb, total, raw, parts: json.audios.length };
}

// Audition every female voice on one representative line so the choice can be
// made by ear. Maya's voice is a product decision, not a passing assertion.
async function auditionSpeakers(model) {
  const line = SAMPLES[0].text;
  console.log("── Voice audition (female speakers, one line each) ──");
  const results = [];
  for (const sp of FEMALE_SPEAKERS) {
    process.stdout.write(`  ${sp.padEnd(8)} `);
    try {
      const r = await synth(line, sp, model);
      if (!r.ok) {
        console.log(`✖ HTTP ${r.status} — ${r.detail.slice(0, 90)}`);
        continue;
      }
      const info = inspectWav(r.raw);
      const file = path.join(OUT_DIR, `voice-${sp}.pcm`);
      fs.writeFileSync(file, info.pcm);
      const secs = (info.pcm.length / 2 / 8000).toFixed(1);
      console.log(`✔ ${String(r.total).padStart(4)}ms  ${secs}s audio  → voice-${sp}.pcm`);
      results.push({ speaker: sp, ms: r.total });
    } catch (err) {
      console.log(`✖ ${err.message}`);
    }
  }
  return results;
}

async function main() {
  loadEnv();
  if (!process.env.SARVAM_API_KEY) {
    console.error("SARVAM_API_KEY is not set (env or .env).");
    console.error("This spike cannot run without a key — Gujarati TTS is blocked on it.");
    process.exit(2);
  }
  const model = process.env.SARVAM_MODEL || "bulbul:v3";
  // Default to a valid bulbul:v3 female voice. "anushka" is NOT valid for v3 —
  // the API rejects it with a list of the ones that are.
  const speaker = process.env.SARVAM_SPEAKER || "ritu";
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Sarvam Bulbul smoke — model=${model} speaker=${speaker} lang=gu-IN rate=8000\n`);

  if (process.argv.includes("--audition")) {
    await auditionSpeakers(model);
    console.log(`\nListen and pick one, then set SARVAM_SPEAKER:`);
    console.log(`  ffplay -f s16le -ar 8000 -ac 1 ${path.join(OUT_DIR, "voice-ritu.pcm")}\n`);
  }

  let failed = 0;
  const latencies = [];
  for (const [i, s] of SAMPLES.entries()) {
    process.stdout.write(`• ${s.label} ... `);
    let r;
    try {
      r = await synth(s.text, speaker, model);
    } catch (err) {
      console.log(`✖ threw: ${err.message}`);
      failed += 1;
      continue;
    }
    if (!r.ok) {
      console.log(`✖ HTTP ${r.status} — ${r.detail}`);
      failed += 1;
      continue;
    }
    const info = inspectWav(r.raw);
    latencies.push(r.total);
    const file = path.join(OUT_DIR, `sarvam-gu-${i}.pcm`);
    fs.writeFileSync(file, info.pcm);
    console.log(
      `✔ ${r.total}ms  container=${info.container}` +
        (info.sampleRate ? ` rate=${info.sampleRate} ch=${info.channels} bits=${info.bitsPerSample}` : "") +
        (info.headerBytes !== undefined ? ` header=${info.headerBytes}B` : "") +
        ` pcm=${info.pcm.length}B parts=${r.parts}`,
    );

    // The checks that actually gate Exotel compatibility.
    if (info.sampleRate && info.sampleRate !== 8000) {
      console.log(`    ⚠ sample rate is ${info.sampleRate}, Exotel needs 8000 — resample required`);
      failed += 1;
    }
    if (info.channels && info.channels !== 1) {
      console.log(`    ⚠ ${info.channels} channels, Exotel needs mono`);
      failed += 1;
    }
    if (info.bitsPerSample && info.bitsPerSample !== 16) {
      console.log(`    ⚠ ${info.bitsPerSample}-bit, Exotel needs 16-bit`);
      failed += 1;
    }
    if (info.pcm.length % 2 !== 0) {
      console.log(`    ⚠ odd PCM byte count — not whole 16-bit samples`);
      failed += 1;
    }
  }

  if (latencies.length) {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const max = Math.max(...latencies);
    console.log(`\nLatency: avg=${avg}ms max=${max}ms  (ElevenLabs per-sentence TTFB ~200-400ms)`);
    if (max > 1500) {
      console.log(
        "⚠ REST is too slow for the live path — as expected. This is why the live path uses\n" +
          "  the WebSocket (see sarvam-ws-smoke.js / SarvamService.synthesizeStream, ~235ms TTFB).\n" +
          "  REST is only used for getClip/prewarmClips, which are warmed at call start.",
      );
    } else {
      console.log("✔ REST latency is in the workable range.");
    }
  }

  console.log(`\nPCM written to ${OUT_DIR} — LISTEN to it before picking the voice:`);
  console.log(`  ffplay -f s16le -ar 8000 -ac 1 ${path.join(OUT_DIR, "sarvam-gu-0.pcm")}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
