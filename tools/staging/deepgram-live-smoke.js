/**
 * LIVE smoke test against the real Deepgram API — validates the exact request
 * configs this service now uses, with your DEEPGRAM_API_KEY. It confirms auth,
 * the Nova-3 endpoint, model name, `language=multi`, and `keyterm` actually work
 * — the things a typecheck/offline test can't.
 *
 * It sends a short synthetic tone (not speech), so it does NOT verify transcript
 * accuracy — it verifies the request is ACCEPTED and the stream behaves. Real
 * accuracy is validated separately with recorded calls (see deepgram-keyword-ab.js).
 *
 * Billing: makes a handful of tiny (<2s) requests — negligible cost. Sends only
 * a synthetic tone, no caller data.
 *
 * Usage:
 *   node tools/staging/deepgram-live-smoke.js
 *   pnpm staging:deepgram-smoke
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

// Resolve the `ws` package from apps/api (header auth needs it; the global
// WebSocket can't set an Authorization header).
const apiRequire = createRequire(path.resolve(__dirname, "../../apps/api/package.json"));
const WebSocket = apiRequire("ws");

// ── Minimal .env loader (never overrides an already-set var) ──────────────────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

// Shared proper-noun keyterms (mirror of apps/api/src/stt/keyterms.ts). Both
// scripts on purpose: Latin biases English-spoken names, Devanagari biases the
// same names spoken inside Hindi. Keep in sync with keyterms.ts.
const KEYTERMS = [
  // Latin
  "Ambli", "Bopal", "Ambli-Bopal Road", "Iskcon",
  "bungalow", "bungalows", "penthouse", "duplex",
  "Sindhu", "Bhavan", "Rajpath", "Rangoli",
  "Thaltej", "Vastrapur", "Nehrunagar", "Vaishnodevi", "Gota",
  "Shilaj", "Nandoli", "Bodakdev",
  // Devanagari
  "वैष्णोदेवी", "थलतेज", "वस्त्रापुर", "नेहरूनगर", "गोता",
  "सिंधु भवन", "राजपथ", "रंगोली", "अंबली", "बोपल",
  "बोडकदेव", "शिलज", "नंदोली", "बंगला",
];

const RATE = 8000; // Exotel pcm_8000

// A short 8kHz mono s16le sine tone as raw PCM (not speech — handshake exercise).
function tonePcm(seconds, freq = 440) {
  const n = Math.floor(seconds * RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.3 * 32767), i * 2);
  }
  return buf;
}

// A 0.5s silent 8kHz mono 16-bit WAV (header + zeros) for the REST endpoint.
function silenceWav(seconds = 0.5) {
  const dataLen = Math.floor(seconds * RATE) * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const KEY = () => process.env.DEEPGRAM_API_KEY;

// ── Test 1: Nova-3 pre-recorded (REST) — DeepgramService config path ──────────
async function testNova3Rest(language) {
  const params = new URLSearchParams({ model: "nova-3", language, punctuate: "true", smart_format: "true" });
  for (const t of KEYTERMS) params.append("keyterm", t);
  const started = Date.now();
  try {
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${KEY()}`, "Content-Type": "audio/wav" },
      body: silenceWav(),
    });
    const body = await res.text();
    return {
      label: `Nova-3 REST (language=${language})`,
      ok: res.ok,
      detail: res.ok ? `HTTP ${res.status}, ${Date.now() - started}ms, request accepted` : `HTTP ${res.status}: ${body.slice(0, 160)}`,
    };
  } catch (err) {
    return { label: `Nova-3 REST (language=${language})`, ok: false, detail: String(err) };
  }
}

// ── WS harness: open, stream ~1.5s of tone, collect messages, close ───────────
function runWs({ label, url, closeMsg, classify }) {
  return new Promise((resolve) => {
    const result = { label, ok: false, opened: false, events: {}, transcripts: [], errorFrame: null, closeCode: null };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      result.ok = result.opened && !result.errorFrame;
      const evs = Object.entries(result.events).map(([k, v]) => `${k}×${v}`).join(", ") || "none";
      result.detail = result.opened
        ? `opened; events: [${evs}]; transcripts: ${result.transcripts.length}${result.errorFrame ? `; ERROR: ${result.errorFrame}` : ""}; close=${result.closeCode ?? "?"}`
        : `did NOT open${result.errorFrame ? `; ${result.errorFrame}` : ""}; close=${result.closeCode ?? "?"}`;
      resolve(result);
    };

    let ws;
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Token ${KEY()}` } });
    } catch (err) {
      result.errorFrame = String(err);
      return finish();
    }
    const guard = setTimeout(() => {
      try { ws.close(); } catch {}
      finish();
    }, 8000);

    ws.on("open", () => {
      result.opened = true;
      const tone = tonePcm(1.5);
      for (let off = 0; off < tone.length; off += 3200) ws.send(tone.subarray(off, off + 3200));
      // Give the model time to emit turn/transcript events, then close cleanly.
      setTimeout(() => {
        try { if (closeMsg) ws.send(JSON.stringify(closeMsg)); ws.close(); } catch {}
      }, 2500);
    });
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const c = classify(msg);
      if (c?.event) result.events[c.event] = (result.events[c.event] ?? 0) + 1;
      if (c?.transcript) result.transcripts.push(c.transcript);
      if (c?.error) result.errorFrame = c.error;
    });
    ws.on("error", (err) => { result.errorFrame = result.errorFrame ?? err.message; });
    ws.on("close", (code) => { result.closeCode = code; clearTimeout(guard); finish(); });
  });
}

function testNova3Live(language) {
  const params = new URLSearchParams({
    model: "nova-3", language, encoding: "linear16", sample_rate: String(RATE), channels: "1",
    punctuate: "true", smart_format: "true", interim_results: "true", endpointing: "250",
    utterance_end_ms: "1000", vad_events: "true",
  });
  for (const t of KEYTERMS) params.append("keyterm", t);
  return runWs({
    label: `Nova-3 live WS (language=${language})`,
    url: `wss://api.deepgram.com/v1/listen?${params}`,
    closeMsg: { type: "CloseStream" },
    classify: (m) => {
      if (m.type === "Results") return { event: "Results", transcript: m.channel?.alternatives?.[0]?.transcript || null };
      if (m.type === "Metadata") return { event: "Metadata" };
      if (m.type === "UtteranceEnd") return { event: "UtteranceEnd" };
      if (m.type === "SpeechStarted") return { event: "SpeechStarted" };
      if (m.type === "Error" || m.error) return { error: JSON.stringify(m).slice(0, 160) };
      return { event: m.type || "unknown" };
    },
  });
}

async function main() {
  loadEnv();
  if (!KEY()) throw new Error("DEEPGRAM_API_KEY is not set (env or .env).");
  console.log("Deepgram live smoke — synthetic tone, validates request acceptance + handshake.\n");

  const results = [];
  // Nova-3 (production STT). multi = Hindi/English code-switch; gu = Gujarati standalone.
  results.push(await testNova3Rest("multi"));
  results.push(await testNova3Rest("gu"));
  results.push(await testNova3Live("multi"));
  results.push(await testNova3Live("gu"));

  console.log("");
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? "✔" : "✖"} ${r.label}\n    ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} configs accepted by Deepgram.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
