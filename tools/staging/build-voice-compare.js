/**
 * Builds a self-contained HTML A/B page from the raw PCM the voice spikes wrote,
 * so the Gujarati-voice decision can be made by ear without ffplay.
 *
 * Every *.pcm in out/ is raw s16le 8kHz mono (Exotel's format). Browsers can't
 * play headerless PCM, so each clip is wrapped in a 44-byte WAV header and
 * embedded as a data: URI. Output is one HTML file with <audio> players.
 */
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "out");
const HTML = path.join(OUT_DIR, "voice-compare.html");
const SAMPLE_RATE = 8000;

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits/sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function dataUri(pcmFile) {
  const pcm = fs.readFileSync(path.join(OUT_DIR, pcmFile));
  return `data:audio/wav;base64,${pcmToWav(pcm).toString("base64")}`;
}

function player(pcmFile) {
  if (!fs.existsSync(path.join(OUT_DIR, pcmFile))) {
    return `<span class="missing">missing: ${pcmFile}</span>`;
  }
  return `<audio controls preload="none" src="${dataUri(pcmFile)}"></audio>`;
}

// The decision: Maya's exact voice (Gargi via v3) vs Sarvam, same two lines.
const DECISION = [
  {
    line: "Short ack — “Perfect. તમે roughly કયા budget…”",
    a: "v3-eleven_v3-pcm_8000-short.pcm",
    b: "ws-buf50-0.pcm",
  },
  {
    line: "Greeting — “Hello, હું Maya બોલી રહી છું…”",
    a: "v3-eleven_v3-pcm_8000-greeting.pcm",
    b: "ws-buf50-1.pcm",
  },
];

// The 10 female Sarvam voices, same greeting line, if the choice is Sarvam.
const SARVAM_VOICES = [
  "ritu", "priya", "neha", "pooja", "simran",
  "kavya", "ishita", "shreya", "roopa", "tanya",
];

const rows = DECISION.map(
  (d) => `
    <tr>
      <td class="line">${d.line}</td>
      <td><div class="cell"><span class="tag tag-same">Gargi · v3</span><span class="lat bad">~1–1.5s</span>${player(d.a)}</div></td>
      <td><div class="cell"><span class="tag tag-sarvam">Sarvam · ritu</span><span class="lat good">~235ms</span>${player(d.b)}</div></td>
    </tr>`,
).join("");

const voiceCards = SARVAM_VOICES.map(
  (v) => `<div class="voice"><div class="vname">${v}</div>${player(`voice-${v}.pcm`)}</div>`,
).join("");

const html = `<h1>Maya · Gujarati voice — listen &amp; decide</h1>
<p class="sub">Every clip is real Gujarati at 8&nbsp;kHz (Exotel's format). Play them; the numbers are measured time-to-first-audio.</p>

<section>
  <h2>The decision — same voice vs speed</h2>
  <p>Left is Maya's <strong>exact ElevenLabs voice</strong> (Gargi) speaking Gujarati via <code>eleven_v3</code> — one identity across all three languages, but slow. Right is <strong>Sarvam</strong> — a different but warm female voice, as responsive as her Hindi.</p>
  <table>
    <thead><tr><th>Line</th><th>Same voice (v3)</th><th>Sarvam (fast)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">The gap is widest on the <em>short ack</em> — the most frequent, most latency-sensitive reply. That's the one to judge hardest.</p>
</section>

<section>
  <h2>If you choose Sarvam — pick the voice</h2>
  <p>All ten female <code>bulbul:v3</code> voices saying the greeting line. Set the winner as <code>SARVAM_SPEAKER</code>. Judge against Gargi's warm/calm register.</p>
  <div class="voices">${voiceCards}</div>
</section>

<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e5e5e5; --card:#fafafa; --same:#7c3aed; --sarvam:#0891b2; --good:#059669; --bad:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161616; --fg:#ececec; --muted:#9a9a9a; --line:#2c2c2c; --card:#1e1e1e; } }
  :root[data-theme="dark"] { --bg:#161616; --fg:#ececec; --muted:#9a9a9a; --line:#2c2c2c; --card:#1e1e1e; }
  :root[data-theme="light"] { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e5e5e5; --card:#fafafa; }
  body { background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; max-width:920px; margin:0 auto; padding:2rem 1.25rem 4rem; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; }
  h2 { font-size:1.15rem; margin:0 0 .6rem; }
  .sub { color:var(--muted); margin:0 0 2rem; }
  section { margin:0 0 2.75rem; }
  section > p { color:var(--muted); margin:.2rem 0 1rem; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:.7rem .6rem; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  td.line, .line { font-size:.92rem; }
  .cell { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
  audio { height:34px; max-width:100%; }
  .tag { font-size:.72rem; font-weight:600; padding:.1rem .45rem; border-radius:999px; color:#fff; white-space:nowrap; }
  .tag-same { background:var(--same); } .tag-sarvam { background:var(--sarvam); }
  .lat { font-size:.75rem; font-weight:600; } .lat.good { color:var(--good); } .lat.bad { color:var(--bad); }
  .note { font-size:.88rem; }
  .voices { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:.75rem; }
  .voice { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:.7rem; }
  .vname { font-weight:600; margin-bottom:.4rem; text-transform:capitalize; }
  .missing { color:var(--bad); font-size:.8rem; }
  code { background:var(--card); padding:.05rem .3rem; border-radius:4px; font-size:.88em; }
</style>`;

fs.writeFileSync(HTML, html);
const kb = (fs.statSync(HTML).size / 1024).toFixed(0);
console.log(`Wrote ${HTML} (${kb} KB)`);
console.log(`Open it in a browser and play the clips.`);
