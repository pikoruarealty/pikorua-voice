// Cost page, served at /costs (behind the dashboard password). Reads /api/costs.
export const COSTS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pikorua Voice Costs</title>
<style>
  :root { --bg:#f4f6f8; --card:#fff; --ink:#1d2329; --muted:#5f6b76; --line:#dde2e7;
    --accent:#116b5f; --warn:#9a6400; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111417; --card:#1a1f24; --ink:#e7ebef;
    --muted:#9aa6b2; --line:#2b333b; --accent:#3fbf9f; --warn:#e0a32e; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 15px; margin: 28px 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  nav { display:flex; gap:8px; flex-wrap:wrap; }
  nav a, select { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--card); color: var(--ink); text-decoration: none; }
  nav a.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(190px,1fr)); gap: 10px; margin-top: 16px; }
  .tile { background: var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .tile .k { color: var(--muted); font-size: 13px; } .tile .v { font-size: 26px; font-weight: 700; margin-top: 2px; }
  .tile .s { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .notice { margin-top: 14px; padding: 10px 14px; border-radius: 10px; border:1px solid var(--warn);
    color: var(--warn); background: var(--card); font-size: 14px; }
  table { width:100%; border-collapse: collapse; background: var(--card); border:1px solid var(--line);
    border-radius:10px; overflow:hidden; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid var(--line); font-size: 14px;
    white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tr:last-child td { border-bottom: 0; }
  .scroll { overflow-x: auto; }
  .bar { height: 8px; border-radius: 4px; background: var(--accent); }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--line); color: var(--muted); }
  .foot { margin-top: 24px; }
</style>
</head>
<body>
<main>
  <header>
    <div><h1>Pikorua Voice · Costs</h1><div class="muted" id="when">Loading…</div></div>
    <nav>
      <a href="/status">Status</a><a href="/costs" class="on">Costs</a><a href="/">Test call</a>
      <select id="days"><option value="1">Last 24 h</option><option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>
    </nav>
  </header>
  <div id="notice"></div>
  <div class="tiles" id="tiles"></div>
  <h2>By service</h2>
  <div class="scroll"><table id="services"></table></div>
  <h2>Recent calls</h2>
  <div class="scroll"><table id="calls"></table></div>
  <p class="muted foot" id="foot"></p>
</main>
<script>
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
  const inr = (n, d) => "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 });
  const mmss = (s) => Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
  const SERVICES = [
    ["llm", "AI replies (OpenRouter)", "measured: billed per turn"],
    ["tts", "Voice (Sarvam)", "estimated: characters × rate"],
    ["stt", "Speech-to-text (Sarvam)", "estimated: call time × rate"],
    ["phone", "Phone lines (Exotel)", "estimated: call time × rate"],
  ];
  async function load() {
    const days = document.getElementById("days").value;
    try {
      const r = await fetch("/api/costs?days=" + days, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json(), t = d.totals, p = d.perCall;
      document.getElementById("when").textContent = "Updated " + new Date(d.generatedAt).toLocaleTimeString();
      document.getElementById("notice").innerHTML = d.ratesMissing.length
        ? '<div class="notice">Phone-line cost is ₹0 because <b>' + esc(d.ratesMissing.join(", ")) +
          "</b> isn't set in .env, so totals below leave out Exotel. Set it to your per-minute rate.</div>" : "";
      document.getElementById("tiles").innerHTML = [
        ["Total spend", inr(t.total), t.calls + " calls (" + t.answeredCalls + " answered" + (t.demoCalls ? ", " + t.demoCalls + " browser demo" : "") + ")"],
        ["Cost per answered call", inr(p.total), "average call " + mmss(p.avgDurationSec)],
        ["Biggest cost", (() => { const m = SERVICES.map(([k, n]) => [n, t[k]]).sort((a, b) => b[1] - a[1])[0]; return t.total ? m[0].split(" (")[0] : "-"; })(), "share of total spend"],
      ].map(([k, v, s]) => '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
        '</div><div class="s">' + esc(s) + "</div></div>").join("");
      document.getElementById("services").innerHTML =
        "<tr><th>Service</th><th>Total</th><th>Per answered call</th><th>Share</th><th></th></tr>" +
        SERVICES.map(([k, n, how]) => {
          const share = t.total ? (t[k] / t.total) * 100 : 0;
          return "<tr><td>" + esc(n) + '<div class="muted">' + esc(how) + "</div></td><td>" + inr(t[k]) + "</td><td>" +
            inr(p[k]) + "</td><td>" + share.toFixed(0) + '%</td><td style="width:22%"><div class="bar" style="width:' + share + '%"></div></td></tr>';
        }).join("") + "<tr><td><b>Total</b></td><td><b>" + inr(t.total) + "</b></td><td><b>" + inr(p.total) + "</b></td><td></td><td></td></tr>";
      document.getElementById("calls").innerHTML =
        "<tr><th>When</th><th>Direction</th><th>Time</th><th>Turns</th><th>AI</th><th>Voice</th><th>STT</th><th>Phone</th><th>Total</th></tr>" +
        (d.calls.length ? d.calls.map((c) =>
          "<tr><td>" + esc(new Date(c.at).toLocaleString()) + (c.isDemo ? ' <span class="badge">demo</span>' : "") +
          "</td><td>" + esc(c.direction) + "</td><td>" + mmss(c.durationSec) + "</td><td>" + c.turns + "</td><td>" + inr(c.llm) +
          "</td><td>" + inr(c.tts) + "</td><td>" + inr(c.stt) + "</td><td>" + inr(c.phone) + "</td><td><b>" + inr(c.total) +
          "</b></td></tr>").join("") : '<tr><td colspan="9" class="muted">No calls in this period.</td></tr>');
      const r2 = d.rates;
      document.getElementById("foot").textContent =
        "Rates used: $1 = ₹" + r2.usdInr + " · voice ₹" + r2.ttsInrPer10kChars + " per 10,000 characters · speech-to-text ₹" +
        r2.sttInrPerHour + "/hour · phone ₹" + r2.exotelInrPerMin + "/min. Not included: the AI call that scores each lead after the call. " +
        "Recorded lines (greeting, goodbyes) cost ₹0 but are counted at the voice rate, and a reply spoken by the ElevenLabs fallback is priced at the Sarvam rate, so voice is a slight over-estimate.";
    } catch (e) {
      document.getElementById("when").textContent = "Can't load costs: " + e.message;
    }
  }
  document.getElementById("days").onchange = load;
  load();
</script>
</body>
</html>`;
