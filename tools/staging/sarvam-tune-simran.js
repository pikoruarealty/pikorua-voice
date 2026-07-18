/**
 * Tuning sweep for Maya's chosen Gujarati voice (Simran): find the pace +
 * temperature that reads "a bit slow, more human".
 *
 * Two knobs on bulbul:v3:
 *   pace        0.5-2.0 — speed. We test BOTH sides of 1.0 because the docs
 *               don't state which direction is slower; the ear decides.
 *   temperature — expressiveness / intonation variation. v3's replacement for
 *               v2's pitch+loudness. Higher = more natural/varied, but too high
 *               drifts. We sweep a small range around the default.
 *
 * Writes one WAV per combination + an HTML compare page. Play them, pick the
 * pair, then set SARVAM_PACE / SARVAM_TEMPERATURE in .env.
 *
 * Usage: node tools/staging/sarvam-tune-simran.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const apiRequire = createRequire(path.resolve(__dirname, "../../apps/api/package.json"));
const WebSocket = apiRequire("ws");

const OUT_DIR = path.join(__dirname, "out");
const SPEAKER = "simran";
const MODEL = "bulbul:v3";

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

function pcmToWav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// A line with both the warm register and the code-switched English, so the tone
// judgement is on realistic material.
const TEXT =
  "Hello, હું Maya બોલી રહી છું પિકોરા Group તરફથી. અમારું એક curated 5 BHK residence સિંધુ ભવન રોડ પર છે — Ready to Move In. આજે 11 વાગ્યે સવારે convenient રહેશે કે 5 વાગ્યે સાંજે?";

// Slower = "a bit slow". Include 1.0 as the reference and both sides so the
// direction is unambiguous once heard.
const PACES = [0.8, 0.9, 1.0];
// Around the default. If the API rejects `temperature` on v3, the run logs it
// and falls back to omitting it (so the sweep still produces pace-only samples).
const TEMPS = [null, 0.7, 1.0];

function synth({ pace, temperature }) {
  return new Promise((resolve) => {
    const url = `wss://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(MODEL)}&send_completion_event=true`;
    const ws = new WebSocket(url, { headers: { "api-subscription-key": process.env.SARVAM_API_KEY } });
    const chunks = [];
    let done = false, error = null, ttfb = null, start = 0;
    const finish = () => {
      if (done) return; done = true; clearTimeout(g);
      try { ws.close(); } catch {}
      resolve({ ok: !error && chunks.length > 0, error, ttfb, pcm: Buffer.concat(chunks) });
    };
    const g = setTimeout(() => { error = error ?? "timeout"; finish(); }, 20000);
    ws.on("open", () => {
      start = Date.now();
      const data = {
        target_language_code: "gu-IN", speaker: SPEAKER, model: MODEL,
        output_audio_codec: "linear16", speech_sample_rate: "8000",
        pace, enable_preprocessing: false, min_buffer_size: 50, max_chunk_length: 150,
      };
      if (temperature !== null) data.temperature = temperature;
      ws.send(JSON.stringify({ type: "config", data }));
      ws.send(JSON.stringify({ type: "text", data: { text: TEXT } }));
      ws.send(JSON.stringify({ type: "flush" }));
    });
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "audio" && m.data?.audio) {
        if (ttfb === null) ttfb = Date.now() - start;
        chunks.push(stripWavHeader(Buffer.from(m.data.audio, "base64")));
      } else if (m.type === "event" && (m.event_type === "final" || m.data?.event_type === "final")) finish();
      else if (m.type === "error") { error = JSON.stringify(m.data ?? m).slice(0, 160); finish(); }
    });
    ws.on("error", (e) => { error = error ?? e.message; finish(); });
    ws.on("close", () => finish());
  });
}

async function main() {
  loadEnv();
  if (!process.env.SARVAM_API_KEY) { console.error("SARVAM_API_KEY not set."); process.exit(2); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Tuning ${SPEAKER} (${MODEL}) — pace × temperature sweep\n`);

  const cells = [];
  let tempRejected = false;
  for (const pace of PACES) {
    for (const temperature of TEMPS) {
      const tag = `p${pace}${temperature === null ? "" : `-t${temperature}`}`;
      process.stdout.write(`  pace=${pace} temp=${temperature ?? "—"}  `);
      const r = await synth({ pace, temperature });
      if (!r.ok) {
        console.log(`✖ ${r.error}`);
        if (/temperature/i.test(r.error || "")) tempRejected = true;
        continue;
      }
      const file = `tune-${SPEAKER}-${tag}.wav`;
      fs.writeFileSync(path.join(OUT_DIR, file), pcmToWav(r.pcm));
      const secs = (r.pcm.length / 2 / 8000).toFixed(1);
      console.log(`✔ ttfb=${String(r.ttfb).padStart(4)}ms ${secs}s → ${file}`);
      cells.push({ pace, temperature, file, secs });
    }
  }

  if (tempRejected) {
    console.log("\n⚠ v3 rejected `temperature` — tone is pace-only for now. Tell me and I'll drop it.");
  }

  // Duration is the objective read on pace direction: longer audio = slower speech.
  const byPace = {};
  for (const c of cells) (byPace[c.pace] ??= []).push(Number(c.secs));
  console.log("\nDuration by pace (longer = slower speech):");
  for (const p of PACES) {
    const ds = byPace[p] || [];
    if (ds.length) console.log(`  pace=${p}: ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(1)}s avg`);
  }

  // Compare page.
  const rows = cells.map((c) => {
    const uri = `data:audio/wav;base64,${fs.readFileSync(path.join(OUT_DIR, c.file)).toString("base64")}`;
    return `<tr><td>pace <b>${c.pace}</b></td><td>temp <b>${c.temperature ?? "—"}</b></td><td>${c.secs}s</td><td><audio controls preload="none" src="${uri}"></audio></td></tr>`;
  }).join("");
  const html = `<h1>Simran — pace &amp; tone tuning</h1>
<p style="color:#666">Same Gujarati line at every pace × temperature. Pick the row that sounds "a bit slow, more human", then set <code>SARVAM_PACE</code> / <code>SARVAM_TEMPERATURE</code>.</p>
<table style="border-collapse:collapse;width:100%">
<thead><tr><th style="text-align:left;padding:.5rem">Pace</th><th style="text-align:left;padding:.5rem">Temp</th><th style="text-align:left;padding:.5rem">Length</th><th style="text-align:left;padding:.5rem">Play</th></tr></thead>
<tbody>${rows}</tbody></table>
<style>body{font:16px system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem}td,th{border-bottom:1px solid #ddd;padding:.55rem .5rem}audio{height:34px}@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}td,th{border-color:#333}}code{background:#8881;padding:.1rem .3rem;border-radius:4px}</style>`;
  fs.writeFileSync(path.join(OUT_DIR, "simran-tuning.html"), html);
  console.log(`\nCompare page: tools/staging/out/simran-tuning.html`);
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
