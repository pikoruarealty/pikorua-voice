/**
 * Is the Gujarati actually INTELLIGIBLE — or just audio-shaped noise?
 *
 * "The API returned 200 and some bytes" is not evidence that Maya said anything
 * a Gujarati speaker would understand. eleven_v3 speaks 70+ languages with a
 * voice (Gargi) that was trained on Hindi; that voice reading Gujarati could
 * plausibly come out as Hindi-accented mush.
 *
 * So: round-trip it. Synthesize the same Gujarati sentence on both engines, feed
 * each back through Deepgram nova-3 (language=gu) — the SAME recognizer that
 * will hear the real caller — and compare the transcript to what we asked for.
 * This is objective evidence, and it is the closest thing to a native ear we can
 * automate. It does NOT replace a human listen for tone/register.
 *
 * Usage: node tools/staging/gujarati-intelligibility.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const apiRequire = createRequire(path.resolve(__dirname, "../../apps/api/package.json"));
const WebSocket = apiRequire("ws");
const OUT_DIR = path.join(__dirname, "out");

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function stripWavHeader(buf) {
  if (buf.length < 12) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return buf;
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "data") return buf.subarray(o + 8, Math.min(o + 8 + size, buf.length));
    o += 8 + size + (size % 2);
  }
  return buf;
}

// Maya's real lines — code-switched, because that is the hard part.
const LINES = [
  "તમે 4 BHK જોઈ રહ્યા છો કે 5 BHK.",
  "તમે roughly કયા budget માં comfortable છો?",
  "અમારું એક curated residence સિંધુ ભવન રોડ પર છે.",
];

async function elevenV3(text) {
  const vid = process.env.ELEVENLABS_VOICE_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream?output_format=pcm_8000`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_v3",
      voice_settings: { stability: 0.55, similarity_boost: 0.9 },
    }),
  });
  if (!resp.ok) throw new Error(`v3 HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
  return Buffer.from(await resp.arrayBuffer());
}

function sarvamWs(text) {
  return new Promise((resolve, reject) => {
    const model = process.env.SARVAM_MODEL || "bulbul:v3";
    const speaker = process.env.SARVAM_SPEAKER || "ritu";
    const ws = new WebSocket(
      `wss://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(model)}&send_completion_event=true`,
      { headers: { "api-subscription-key": process.env.SARVAM_API_KEY } },
    );
    const chunks = [];
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(g);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(Buffer.concat(chunks));
    };
    const g = setTimeout(() => done(new Error("sarvam timeout")), 20000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "config", data: {
        target_language_code: "gu-IN", speaker, model,
        output_audio_codec: "linear16", speech_sample_rate: "8000",
        pace: 1.0, enable_preprocessing: false, min_buffer_size: 50, max_chunk_length: 150,
      }}));
      ws.send(JSON.stringify({ type: "text", data: { text } }));
      ws.send(JSON.stringify({ type: "flush" }));
    });
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "audio" && m.data?.audio) chunks.push(stripWavHeader(Buffer.from(m.data.audio, "base64")));
      else if (m.type === "event" && (m.event_type === "final" || m.data?.event_type === "final")) done();
      else if (m.type === "error") done(new Error(m.data?.message || "sarvam error"));
    });
    ws.on("error", (e) => done(e));
    ws.on("close", () => done());
  });
}

// Same recognizer + same language code the live gateway uses for a gu call.
async function transcribe(pcm) {
  const url =
    "https://api.deepgram.com/v1/listen?model=nova-3&language=gu&encoding=linear16&sample_rate=8000&channels=1&punctuate=true&smart_format=true";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/raw",
    },
    body: pcm,
  });
  if (!resp.ok) throw new Error(`deepgram HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
  const j = await resp.json();
  const alt = j.results?.channels?.[0]?.alternatives?.[0];
  return { text: (alt?.transcript || "").trim(), confidence: alt?.confidence ?? null };
}

// Crude token overlap — enough to tell "understood" from "mush". Not a linguistic
// metric; a human still has to listen.
function overlap(expected, actual) {
  const norm = (s) => s.toLowerCase().replace(/[.,?!।]/g, " ").split(/\s+/).filter(Boolean);
  const e = norm(expected);
  const a = new Set(norm(actual));
  if (!e.length) return 0;
  return Math.round((e.filter((t) => a.has(t)).length / e.length) * 100);
}

async function main() {
  loadEnv();
  for (const k of ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "DEEPGRAM_API_KEY", "SARVAM_API_KEY"]) {
    if (!process.env[k]) { console.error(`${k} not set`); process.exit(2); }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("Gujarati intelligibility round-trip: TTS → Deepgram nova-3 (language=gu) → compare\n");

  const engines = [
    { name: "eleven_v3 (Gargi — SAME voice)", fn: elevenV3, tag: "v3" },
    { name: `sarvam ${process.env.SARVAM_SPEAKER || "ritu"} (different voice)`, fn: sarvamWs, tag: "sarvam" },
  ];

  for (const eng of engines) {
    console.log(`── ${eng.name} ──`);
    let sum = 0, n = 0;
    for (const [i, line] of LINES.entries()) {
      try {
        const pcm = await eng.fn(line);
        fs.writeFileSync(path.join(OUT_DIR, `intel-${eng.tag}-${i}.pcm`), pcm);
        const { text, confidence } = await transcribe(pcm);
        const score = overlap(line, text);
        sum += score; n += 1;
        console.log(`  want: ${line}`);
        console.log(`  got : ${text || "(nothing recognized)"}`);
        console.log(`  overlap=${score}%  dg_confidence=${confidence !== null ? confidence.toFixed(2) : "n/a"}\n`);
      } catch (err) {
        console.log(`  ✖ ${err.message}\n`);
      }
    }
    if (n) console.log(`  AVERAGE OVERLAP: ${Math.round(sum / n)}%\n`);
  }

  console.log("Note: overlap is a rough proxy. Deepgram may mis-hear correct speech, and a high");
  console.log("score does not prove the tone/register is right — a native listen is still required.");
  console.log(`Audio: ${OUT_DIR}/intel-v3-*.pcm and intel-sarvam-*.pcm`);
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
