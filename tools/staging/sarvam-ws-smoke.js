/**
 * Sarvam Bulbul TTS — WebSocket streaming spike.
 *
 * WHY: the REST path (sarvam-tts-smoke.js) measured 2.2-4.2s per sentence
 * because it synthesizes the whole clip before returning. ElevenLabs delivers
 * first audio in ~200-400ms. That gap makes Maya feel seconds late on EVERY
 * sentence, which is a broken call, not a slow one.
 *
 * This measures the WebSocket path, where audio chunks arrive as they are
 * generated. The number that matters is TTFB — time to the FIRST audio chunk —
 * because that is when the caller starts hearing her.
 *
 * Protocol (per docs.sarvam.ai + pipecat's client):
 *   wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true
 *   header: api-subscription-key
 *   → {"type":"config","data":{...}}
 *   → {"type":"text","data":{"text":"..."}}
 *   → {"type":"flush"}
 *   ← {"type":"audio","data":{"audio":"<base64>"}}
 *   ← {"type":"event","event_type":"final"}
 *
 * Usage: node tools/staging/sarvam-ws-smoke.js
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
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return buf.subarray(offset + 8, Math.min(offset + 8 + size, buf.length));
    offset += 8 + size + (size % 2);
  }
  return buf;
}

const SAMPLES = [
  {
    label: "short ack (latency-critical)",
    text: "Perfect. તમે roughly કયા budget માં comfortable છો?",
  },
  {
    label: "greeting (long, code-switched)",
    text: "Hello, હું Maya બોલી રહી છું પિકોરા Group તરફથી. તમારી enquiry મળી હતી, તો તમને personally invite કરવા માંગતી હતી.",
  },
  {
    label: "pitch (numbers + English terms)",
    text: "અમારું એક curated 5 BHK residence સિંધુ ભવન રોડ પર છે — Ready to Move In, approx five thousand two hundred સ્ક્વેર ફીટ.",
  },
];

// min_buffer_size drives how much text Sarvam accumulates before it starts
// generating — the single biggest lever on TTFB. Try a few to find the knee.
const BUFFER_SIZES = [50];

function synthOverWs(text, { speaker, model, minBufferSize }) {
  return new Promise((resolve) => {
    const url = `wss://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(model)}&send_completion_event=true`;
    const ws = new WebSocket(url, { headers: { "api-subscription-key": process.env.SARVAM_API_KEY } });

    const chunks = [];
    // t0 = before the socket is even opened. This is what a per-SENTENCE WS
    // would actually cost the caller, because it pays the TLS+upgrade handshake
    // every sentence. `start` (set on open) is what a per-TURN session costs for
    // sentences 2..n, since the handshake is amortized. The gap between them
    // decides the architecture.
    const t0 = Date.now();
    let connectMs = null;
    let start = 0;
    let ttfb = null;
    let done = false;
    let error = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      try { ws.close(); } catch {}
      resolve({
        ok: !error && chunks.length > 0,
        error,
        connectMs,
        ttfb,
        // What a cold per-sentence WS really costs: handshake + first audio.
        coldTtfb: ttfb !== null && connectMs !== null ? connectMs + ttfb : null,
        total: start ? Date.now() - start : null,
        pcm: Buffer.concat(chunks),
        chunkCount: chunks.length,
      });
    };
    const guard = setTimeout(() => {
      error = error ?? "timeout after 20s";
      finish();
    }, 20000);

    ws.on("open", () => {
      start = Date.now();
      connectMs = start - t0;
      ws.send(
        JSON.stringify({
          type: "config",
          data: {
            target_language_code: "gu-IN",
            speaker,
            model,
            // linear16 @ 8000 = raw s16le 8kHz = exactly Exotel's wire format.
            output_audio_codec: "linear16",
            speech_sample_rate: "8000",
            pace: 1.0,
            enable_preprocessing: false,
            min_buffer_size: minBufferSize,
            max_chunk_length: 150,
            // NOTE: pitch/loudness are bulbul:v2-only — v3 rejects or ignores them.
          },
        }),
      );
      ws.send(JSON.stringify({ type: "text", data: { text } }));
      ws.send(JSON.stringify({ type: "flush" }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "audio" && msg.data?.audio) {
        if (ttfb === null) ttfb = Date.now() - start;
        chunks.push(stripWavHeader(Buffer.from(msg.data.audio, "base64")));
      } else if (msg.type === "event" && (msg.event_type === "final" || msg.data?.event_type === "final")) {
        finish();
      } else if (msg.type === "error") {
        error = JSON.stringify(msg.data ?? msg).slice(0, 200);
        finish();
      }
    });

    ws.on("error", (err) => {
      error = error ?? err.message;
      finish();
    });
    ws.on("close", () => finish());
  });
}

async function main() {
  loadEnv();
  if (!process.env.SARVAM_API_KEY) {
    console.error("SARVAM_API_KEY is not set (env or .env).");
    process.exit(2);
  }
  const model = process.env.SARVAM_MODEL || "bulbul:v3";
  const speaker = process.env.SARVAM_SPEAKER || "ritu";
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Sarvam WS streaming spike — model=${model} speaker=${speaker} gu-IN linear16@8000`);
  console.log(`Target: first audio in <500ms (ElevenLabs HTTP per-sentence is ~200-400ms)\n`);

  let failed = 0;
  for (const minBufferSize of BUFFER_SIZES) {
    console.log(`── min_buffer_size=${minBufferSize} ──`);
    for (const [i, s] of SAMPLES.entries()) {
      process.stdout.write(`  ${s.label.padEnd(32)} `);
      const r = await synthOverWs(s.text, { speaker, model, minBufferSize });
      if (!r.ok) {
        console.log(`✖ ${r.error ?? "no audio"}`);
        failed += 1;
        continue;
      }
      const secs = (r.pcm.length / 2 / 8000).toFixed(1);
      const file = path.join(OUT_DIR, `ws-buf${minBufferSize}-${i}.pcm`);
      fs.writeFileSync(file, r.pcm);
      console.log(
        `✔ connect=${String(r.connectMs).padStart(4)}ms ttfb=${String(r.ttfb).padStart(4)}ms ` +
          `cold=${String(r.coldTtfb).padStart(4)}ms total=${String(r.total).padStart(4)}ms ` +
          `chunks=${String(r.chunkCount).padStart(3)} audio=${secs}s`,
      );
    }
    console.log("");
  }

  console.log(`PCM written to ${OUT_DIR}`);
  console.log(`  ffplay -f s16le -ar 8000 -ac 1 ${path.join(OUT_DIR, "ws-buf10-0.pcm")}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
