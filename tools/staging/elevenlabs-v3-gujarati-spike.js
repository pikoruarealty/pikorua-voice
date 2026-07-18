/**
 * Can Maya's EXISTING ElevenLabs voice (Gargi) speak Gujarati fast enough?
 *
 * WHY THIS SPIKE: the only licensing-clean way to keep ONE voice across all
 * three languages is eleven_v3 — it supports Gujarati AND can use the same
 * voice_id, all inside ElevenLabs (so Gargi's Voice Library licence still
 * applies and she still gets paid per use). Cloning her into Sarvam is NOT an
 * option: that voice is a third-party professional clone, licensed for use on
 * ElevenLabs only.
 *
 * ElevenLabs' docs say v3 is "not recommended for real-time" and has no
 * WebSocket. But "not recommended" is not a number, and the HTTP /stream
 * endpoint (chunked transfer) is a different thing from WebSockets. So: measure.
 *
 * The bar: Sarvam WS delivers first audio in ~235ms. ElevenLabs turbo (hi/en
 * today) is ~200-400ms. If v3 lands anywhere near that, one voice everywhere
 * wins. If it's seconds, it's a broken call and Sarvam's separate voice is the
 * only realtime answer.
 *
 * Usage: node tools/staging/elevenlabs-v3-gujarati-spike.js
 */
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "out");

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const TEXT = {
  short: "Perfect. તમે roughly કયા budget માં comfortable છો?",
  greeting:
    "Hello, હું Maya બોલી રહી છું પિકોરા Group તરફથી. તમારી enquiry મળી હતી, તો તમને personally invite કરવા માંગતી હતી.",
};

// Hindi lines for the control case (turbo can't speak Gujarati at all).
const HINDI_TEXT = {
  short: "Perfect. आप roughly किस budget में comfortable हैं?",
  greeting:
    "Hello, मैं Maya बोल रही हूँ पिकोरा Group से। आपकी enquiry मिली थी, तो आपको personally invite करना चाहती थी।",
};

// Matrix: the questions that decide viability.
//  - does v3 accept our telephony format (pcm_8000)?
//  - does the HTTP /stream endpoint work for v3 at all?
//  - how does it compare to turbo (which cannot speak Gujarati but sets the bar)?
const CASES = [
  { label: "v3    /stream  pcm_8000", model: "eleven_v3", stream: true, fmt: "pcm_8000" },
  { label: "v3    /stream  mp3_44100_128", model: "eleven_v3", stream: true, fmt: "mp3_44100_128" },
  { label: "v3    (buffered) pcm_8000", model: "eleven_v3", stream: false, fmt: "pcm_8000" },
  // Control: the model hi/en use today, on Hindi text. Establishes the latency
  // bar on the same network. (Asking it for Gujarati returns a hard 400:
  // "Model 'eleven_turbo_v2_5' does not support language_code gu" — the vendor's
  // own API confirming turbo cannot speak Gujarati at all.)
  {
    label: "turbo /stream pcm_8000 (HINDI control)",
    model: "eleven_turbo_v2_5",
    stream: true,
    fmt: "pcm_8000",
    hindi: true,
  },
];

async function run({ model, stream, fmt, hindi }, text) {
  const vid = process.env.ELEVENLABS_VOICE_ID;
  // v3 REJECTS optimize_streaming_latency ("unsupported_model"), so it must be
  // omitted for v3 — otherwise the request 400s and the streaming path never
  // actually gets tested.
  const canOptimize = model !== "eleven_v3";
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${vid}` +
    (stream ? "/stream" : "") +
    `?output_format=${fmt}` +
    (stream && canOptimize ? "&optimize_streaming_latency=3" : "");

  const body = {
    text,
    model_id: model,
    voice_settings: { stability: 0.55, similarity_boost: 0.9 },
  };
  // v3 may infer language itself; send the hint and let the API reject it if not.
  if (model !== "eleven_v3") body.language_code = hindi ? "hi" : "gu";

  const t0 = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    return { ok: false, status: resp.status, detail: detail.slice(0, 240) };
  }

  // Read incrementally so TTFB means "first audio byte", not "whole clip".
  let ttfb = null;
  let bytes = 0;
  const chunks = [];
  for await (const chunk of resp.body) {
    if (ttfb === null) ttfb = Date.now() - t0;
    bytes += chunk.length;
    chunks.push(Buffer.from(chunk));
  }
  return { ok: true, ttfb, total: Date.now() - t0, bytes, buf: Buffer.concat(chunks) };
}

async function main() {
  loadEnv();
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
    console.error("ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set.");
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Can Gargi (${process.env.ELEVENLABS_VOICE_ID}) speak Gujarati fast enough?`);
  console.log(`Bar: Sarvam WS ~235ms · ElevenLabs turbo (hi/en today) ~200-400ms\n`);

  for (const c of CASES) {
    const texts = c.hindi ? HINDI_TEXT : TEXT;
    for (const [key, text] of Object.entries(texts)) {
      process.stdout.write(`  ${c.label.padEnd(38)} ${key.padEnd(9)} `);
      try {
        const r = await run(c, text);
        if (!r.ok) {
          console.log(`✖ HTTP ${r.status} — ${r.detail.replace(/\s+/g, " ").slice(0, 130)}`);
          continue;
        }
        const file = path.join(OUT_DIR, `v3-${c.model}-${c.fmt}-${key}.${c.fmt.startsWith("pcm") ? "pcm" : "mp3"}`);
        fs.writeFileSync(file, r.buf);
        const dur = c.fmt === "pcm_8000" ? ` audio=${(r.bytes / 2 / 8000).toFixed(1)}s` : "";
        console.log(`✔ ttfb=${String(r.ttfb).padStart(5)}ms total=${String(r.total).padStart(5)}ms bytes=${r.bytes}${dur}`);
      } catch (err) {
        console.log(`✖ ${err.message}`);
      }
    }
  }

  console.log(`\nAudio in ${OUT_DIR} — listen to confirm it is actually GUJARATI and not mangled:`);
  console.log(`  ffplay -f s16le -ar 8000 -ac 1 ${path.join(OUT_DIR, "v3-eleven_v3-pcm_8000-greeting.pcm")}`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exitCode = 1;
});
