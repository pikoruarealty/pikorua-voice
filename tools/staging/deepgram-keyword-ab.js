/**
 * Deepgram keyterm-boost A/B harness (settles open question in
 * deepgram-live.service.ts: do Latin keyterm boosts help Nova-3 on Hindi audio,
 * where the model emits Devanagari?).
 *
 * Runs ONE recorded audio file through Deepgram's pre-recorded nova-3 endpoint
 * under several keyterm configurations and prints the transcripts side by side.
 * The pre-recorded path uses the same model + `keyterm` mechanism as the live
 * gateway, so it is a faithful, repeatable proxy for streaming behaviour without
 * real-time pacing. Compare how each variant renders the local area names.
 *
 * Usage:
 *   DEEPGRAM_API_KEY=... node tools/staging/deepgram-keyword-ab.js <audio> [opts]
 *   pnpm staging:deepgram-ab -- <audio> [opts]            (after adding the script)
 *
 * Audio: .wav / .mp3 / .flac (container has the format) OR raw .pcm/.raw/.l16
 *        (pass --rate, default 8000 — matches Exotel pcm_8000).
 *
 * Options:
 *   --lang <code>       Deepgram language (default: multi — matches production
 *                       Hindi/English code-switch routing; use `gu` for Gujarati)
 *   --rate <hz>         sample rate for RAW audio only (default: 8000)
 *   --expect "a,b,c"    comma-separated area terms you EXPECT to hear; the script
 *                       reports how many each variant recovered (crude recall).
 *   --variants a,b,c    subset of: none, latin, latinDevanagari, devanagari
 *                       (default: all four)
 *
 * Example:
 *   node tools/staging/deepgram-keyword-ab.js call.wav \
 *     --expect "सिंधु भवन,थलतेज,अंबली,बोपल,नेहरूनगर"
 */
const fs = require("node:fs");
const path = require("node:path");

// ── Keyterm sets ─────────────────────────────────────────────────────────────
// Nova-3 Keyterm Prompting has no `:intensifier` suffix (that was Nova-2's
// `keywords`); terms are passed verbatim and multi-word phrases are allowed.
// English property terms stay Latin in EVERY variant — they are English words
// and the model emits them in Latin regardless of audio language.
const ENGLISH_TERMS = ["bungalow", "bungalows", "penthouse", "duplex"];

// Production list (mirror of deepgram-live.service.ts keyterms) — all Latin.
const ALIASES_LATIN = ["Iskcon", "Ambli", "Bopal", "Ambli-Bopal Road", "Bodakdev"];
const AREAS_LATIN = [
  "Sindhu", "Bhavan", "Rajpath", "Rangoli",
  "Thaltej", "Vastrapur", "Nehrunagar", "Vaishnodevi", "Gota",
  "Shilaj", "Nandoli",
];

// Devanagari spellings — taken from the system prompt's canonical spellings.
// (Whether these match Nova-3's exact output tokens is precisely what the A/B
// reveals; a near-miss spelling silently fails to bias.)
const ALIASES_DEVA = ["इस्कॉन", "अंबली", "बोपल", "बोडकदेव"];
const AREAS_DEVA = [
  "सिंधु", "भवन", "राजपथ", "रंगोली",
  "थलतेज", "वस्त्रापुर", "नेहरूनगर", "वैष्णोदेवी", "गोता",
  "शिलज", "नंदोली",
];

const VARIANTS = {
  none: [],
  // Exactly what production sends today.
  latin: [...ALIASES_LATIN, ...ENGLISH_TERMS, ...AREAS_LATIN],
  // Hedge: production list PLUS Devanagari area/alias spellings.
  latinDevanagari: [
    ...ALIASES_LATIN, ...ENGLISH_TERMS, ...AREAS_LATIN, ...AREAS_DEVA, ...ALIASES_DEVA,
  ],
  // Devanagari area/alias spellings only (English property terms stay Latin).
  devanagari: [...ENGLISH_TERMS, ...AREAS_DEVA, ...ALIASES_DEVA],
};

// ── Minimal .env loader (convenience; never overrides an already-set var) ─────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv) {
  const opts = { lang: "multi", rate: "8000", expect: [], variants: Object.keys(VARIANTS) };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--lang") opts.lang = argv[++i];
    else if (a === "--rate") opts.rate = argv[++i];
    else if (a === "--expect") opts.expect = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--variants") opts.variants = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else positional.push(a);
  }
  opts.audio = positional[0];
  return opts;
}

const RAW_EXTS = new Set([".raw", ".pcm", ".l16", ".sln"]);
const CONTENT_TYPES = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg" };

function audioRequestParams(audioPath, opts) {
  const ext = path.extname(audioPath).toLowerCase();
  if (RAW_EXTS.has(ext)) {
    // Raw PCM: Deepgram needs the format described explicitly.
    return {
      contentType: "application/octet-stream",
      extraQuery: { encoding: "linear16", sample_rate: opts.rate, channels: "1" },
    };
  }
  return { contentType: CONTENT_TYPES[ext] ?? "application/octet-stream", extraQuery: {} };
}

async function transcribe(audioBytes, keyterms, opts, reqParams) {
  const params = new URLSearchParams({
    model: "nova-3",
    language: opts.lang,
    punctuate: "true",
    smart_format: "true",
    ...reqParams.extraQuery,
  });
  for (const term of keyterms) params.append("keyterm", term);

  const started = Date.now();
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": reqParams.contentType,
    },
    body: audioBytes,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Deepgram ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  return { transcript: String(alt?.transcript ?? "").trim(), ms: Date.now() - started };
}

function recall(transcript, expected) {
  const hay = transcript.toLowerCase();
  const hits = expected.filter((term) => hay.includes(term.toLowerCase()));
  return { hits, count: hits.length, total: expected.length };
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY is not set (env or .env).");
  if (!opts.audio) throw new Error("Provide an audio file path. See header for usage.");
  if (!fs.existsSync(opts.audio)) throw new Error(`Audio file not found: ${opts.audio}`);
  for (const v of opts.variants) {
    if (!VARIANTS[v]) throw new Error(`Unknown variant "${v}". Choose from: ${Object.keys(VARIANTS).join(", ")}`);
  }

  const audioBytes = fs.readFileSync(opts.audio);
  const reqParams = audioRequestParams(opts.audio, opts);

  console.log(`Audio:    ${opts.audio} (${audioBytes.length} bytes, ${reqParams.contentType})`);
  console.log(`Language: ${opts.lang}   Variants: ${opts.variants.join(", ")}`);
  if (opts.expect.length) console.log(`Expecting: ${opts.expect.join(" · ")}`);
  console.log("");

  // Run variants sequentially so output stays ordered and we stay polite to the API.
  for (const variant of opts.variants) {
    try {
      const { transcript, ms } = await transcribe(audioBytes, VARIANTS[variant], opts, reqParams);
      console.log(`── ${variant} ${"─".repeat(Math.max(2, 40 - variant.length))} (${ms}ms, ${VARIANTS[variant].length} keyterms)`);
      console.log(transcript || "(empty transcript)");
      if (opts.expect.length) {
        const r = recall(transcript, opts.expect);
        const missed = opts.expect.filter((t) => !r.hits.includes(t));
        console.log(`   recall: ${r.count}/${r.total}${missed.length ? `   missed: ${missed.join(", ")}` : "  ✓ all"}`);
      }
      console.log("");
    } catch (err) {
      console.error(`── ${variant}: ERROR — ${err.message}\n`);
    }
  }

  console.log(
    "Read the area names across variants. If 'latin' and 'devanagari'/'latinDevanagari'\n" +
      "render them identically, the Latin boosts are doing the work and no change is needed.\n" +
      "If a Devanagari variant recovers names the Latin-only run mangles, add those exact\n" +
      "spellings to the gateway keyterm list (Hindi/Gujarati sessions only).",
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
