// Operator status dashboard, served at /status (behind the dashboard password).
// Polls /api/status; the server caches vendor checks for 60 s.
export const STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pikorua Voice Status</title>
<style>
  :root { --bg:#f4f6f8; --card:#fff; --ink:#1d2329; --muted:#5f6b76; --line:#dde2e7;
    --ok:#137a4b; --warn:#9a6400; --error:#b42318; --off:#6b7280; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111417; --card:#1a1f24; --ink:#e7ebef;
    --muted:#9aa6b2; --line:#2b333b; --ok:#3fbf7f; --warn:#e0a32e; --error:#f0645a; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
  h1 { font-size: 20px; margin: 0; }
  .muted { color: var(--muted); font-size: 13px; }
  .banner { margin: 16px 0; padding: 14px 16px; border-radius: 10px; font-weight: 600;
    border: 1px solid var(--line); background: var(--card); }
  .row { display:grid; grid-template-columns: 14px minmax(0,1fr); gap: 10px 12px; align-items:start;
    background: var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-top:8px; }
  .dot { width:10px; height:10px; border-radius:50%; margin-top:6px; }
  .name { font-weight: 600; }
  .detail { color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
  .ok .dot { background: var(--ok); } .warn .dot { background: var(--warn); }
  .error .dot { background: var(--error); } .off .dot { background: var(--off); }
  .banner.ok { color: var(--ok); } .banner.warn { color: var(--warn); } .banner.error { color: var(--error); }
  h2 { font-size: 15px; margin: 28px 0 4px; }
  dl { display:grid; grid-template-columns: max-content minmax(0,1fr); gap: 6px 16px; margin: 8px 0 0;
    background: var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  button, a.btn { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--card); color: var(--ink); cursor: pointer; text-decoration: none; }
</style>
</head>
<body>
<main>
  <header>
    <div><h1>Pikorua Voice · Status</h1><div class="muted" id="when">Loading…</div></div>
    <div style="display:flex; gap:8px">
      <button id="refresh">Check now</button>
      <a class="btn" href="/costs">Costs</a>
      <a class="btn" href="/">Test call demo</a>
    </div>
  </header>
  <div class="banner" id="banner">Checking services…</div>
  <div id="checks"></div>
  <h2>Live</h2>
  <dl id="runtime"></dl>
</main>
<script>
  const LABEL = { ok: "All services OK", warn: "Working, but something needs attention",
    error: "Something is down: calls may fail or use a fallback" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
  async function load(force) {
    try {
      const r = await fetch("/api/status" + (force ? "?refresh=1" : ""), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const s = await r.json();
      document.getElementById("when").textContent =
        "Checked " + new Date(s.checkedAt).toLocaleTimeString() + " · refreshes every minute";
      const b = document.getElementById("banner");
      b.className = "banner " + s.level; b.textContent = LABEL[s.level] || s.level;
      document.getElementById("checks").innerHTML = s.checks.map((c) =>
        '<div class="row ' + esc(c.level) + '"><span class="dot"></span><div><div class="name">' +
        esc(c.name) + '</div><div class="detail">' + esc(c.detail) + "</div></div></div>").join("");
      const rt = s.runtime, calls = rt.callsInProgress, max = rt.maxCalls;
      const breakers = Object.entries(rt.llmBreakers || {}).map(([k, v]) =>
        k + ": " + (v.openForMs > 0 ? "OPEN for " + Math.ceil(v.openForMs / 1000) + " s" : "closed") +
        " (" + v.failures + " recent failures)").join(" · ") || "no failures since start";
      document.getElementById("runtime").innerHTML = [
        ["Calls in progress", calls ? calls.all + " of " + (max ? max.all : "?") + " (" + calls.outbound + " outbound)" : "unknown"],
        ["AI fallback switch", breakers],
        ["Recorded lines loaded", rt.recordedLines],
        ["API uptime", rt.uptimeMin + " min"],
      ].map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>").join("");
    } catch (e) {
      const b = document.getElementById("banner");
      b.className = "banner error"; b.textContent = "Can't reach the API: " + e.message;
    }
  }
  document.getElementById("refresh").onclick = () => load(true);
  load(false);
  setInterval(() => load(false), 60000);
</script>
</body>
</html>`;
