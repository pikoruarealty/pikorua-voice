/**
 * Sarvam pronunciation + pace/smoothness check.
 *
 * Two problems to pin down by EAR (a passing assertion can't hear "karodh"):
 *   1. "crore" is voiced as "કરોધ" (karodh) instead of "કરોડ" (karod). The prompt
 *      text is already the correct spelling, so this is Sarvam mis-reading the
 *      word — we need a respelling it says right. Candidates below.
 *   2. Voice should be a bit smoother + faster. Pace sweep below.
 *
 * Writes .wav files (double-clickable) to tools/staging/out/. Listen, then tell
 * which crore spelling is correct and which pace sounds best.
 *
 * Usage: node tools/staging/sarvam-fix-check.js   (reads .env for the key/speaker)
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

async function synth(text, { speaker, model, pace, temperature, preprocess }) {
  const body = {
    text,
    target_language_code: "gu-IN",
    speaker,
    model,
    speech_sample_rate: 8000,
    pace,
    enable_preprocessing: preprocess,
    ...(temperature > 0 ? { temperature } : {}),
  };
  const resp = await fetch(URL, {
    method: "POST",
    headers: {
      "api-subscription-key": process.env.SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${(await resp.text()).slice(0, 200)}`);
  const json = await resp.json();
  if (!Array.isArray(json.audios) || !json.audios.length) throw new Error("no audios[]");
  // audios[0] is base64 of a WAV container — write it straight to a .wav file.
  return Buffer.from(json.audios[0], "base64");
}

async function write(name, text, cfg) {
  process.stdout.write(`  ${name.padEnd(28)} `);
  try {
    const wav = await synth(text, cfg);
    fs.writeFileSync(path.join(OUT_DIR, `${name}.wav`), wav);
    console.log(`✔ "${text}"`);
  } catch (err) {
    console.log(`✖ ${err.message}`);
  }
}

async function main() {
  loadEnv();
  if (!process.env.SARVAM_API_KEY) {
    console.error("SARVAM_API_KEY not set (env or .env).");
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = {
    speaker: process.env.SARVAM_SPEAKER || "simran",
    model: process.env.SARVAM_MODEL || "bulbul:v3",
    pace: 1.0,
    temperature: 0.7,
    preprocess: true,
  };

  // ── 1. "crore" pronunciation candidates ────────────────────────────────────
  // Frame each in a real budget sentence so co-articulation matches the call.
  console.log("\n── crore/કરોડ pronunciation candidates ──");
  const frame = (unit) => `તમારું budget ત્રણ ${unit} છે.`;
  await write("crore-1-current", frame("કરોડ"), base); // U+0AA1 ડ — what the prompt uses
  await write("crore-2-nukta", frame("કરોડ઼"), base); // ડ + nukta
  await write("crore-3-conjunct", frame("ક્રોડ"), base); // krod
  await write("crore-4-latin", frame("crore"), base); // let Sarvam read the English
  await write("crore-5-no-preproc", frame("કરોડ"), { ...base, preprocess: false });
  await write("crore-6-karod-roman", frame("karod"), base); // romanized
  await write("crore-7-elongated", frame("કરોઽડ"), base); // avagraha to break ો-ડ blend

  // ── 2. pace / smoothness sweep (a normal line) ──────────────────────────────
  console.log("\n── pace sweep (smoother + faster) ──");
  const line =
    "Hello, હું Maya બોલી રહી છું પિકોરા Group તરફથી. તમે 4 BHK જોઈ રહ્યા છો કે 5 BHK?";
  for (const pace of [1.0, 1.1, 1.15, 1.2, 1.25]) {
    await write(`pace-${String(pace).replace(".", "_")}`, line, { ...base, pace });
  }

  console.log(`\nWAVs in ${OUT_DIR} — double-click to play.`);
  console.log("Tell me: which crore-N sounds like 'karod', and which pace-N you like.");
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
