export const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pikorua Voice — Demo</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-white min-h-screen">
  <div class="max-w-xl mx-auto px-5 py-14">

    <!-- Header -->
    <div class="mb-10">
      <div class="flex items-center gap-3 mb-2">
        <span class="text-3xl">🎙</span>
        <h1 class="text-2xl font-bold tracking-tight">Pikorua Voice</h1>
      </div>
      <p class="text-gray-400 text-sm">AI-powered outbound voice call demo</p>
    </div>

    <!-- Status -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-5">
      <div class="flex items-center justify-between mb-5">
        <span class="text-xs font-semibold text-gray-500 uppercase tracking-widest">System Status</span>
        <span id="badge" class="text-xs px-3 py-1 rounded-full bg-gray-800 text-gray-400 font-medium">checking…</span>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div class="bg-gray-800 rounded-xl p-3 text-center">
          <div id="dot-api" class="w-2.5 h-2.5 rounded-full bg-gray-600 mx-auto mb-2 transition-colors"></div>
          <div class="text-xs text-gray-400">API</div>
        </div>
        <div class="bg-gray-800 rounded-xl p-3 text-center">
          <div id="dot-db" class="w-2.5 h-2.5 rounded-full bg-gray-600 mx-auto mb-2 transition-colors"></div>
          <div class="text-xs text-gray-400">Database</div>
        </div>
        <div class="bg-gray-800 rounded-xl p-3 text-center">
          <div id="dot-redis" class="w-2.5 h-2.5 rounded-full bg-gray-600 mx-auto mb-2 transition-colors"></div>
          <div class="text-xs text-gray-400">Redis</div>
        </div>
      </div>
    </div>

    <!-- Trigger Call -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-5">
      <span class="text-xs font-semibold text-gray-500 uppercase tracking-widest block mb-5">Trigger Demo Call</span>
      <div class="space-y-3">
        <input id="inp-token" type="password" placeholder="API Auth Token"
          class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors" />
        <input id="inp-phone" type="tel" placeholder="Phone number  e.g. +91 98765 43210"
          class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors" />
        <input id="inp-name" type="text" placeholder="Lead name  (optional)"
          class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors" />
        <button onclick="triggerCall()"
          class="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold py-3 rounded-xl transition-colors text-sm">
          Call Now
        </button>
      </div>
      <div id="call-msg" class="mt-3 text-sm hidden rounded-xl px-4 py-3"></div>
    </div>

    <!-- Endpoints -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <span class="text-xs font-semibold text-gray-500 uppercase tracking-widest block mb-4">Endpoints</span>
      <div class="space-y-1 text-xs font-mono">
        <div class="flex gap-3 items-center py-2 border-b border-gray-800">
          <span class="text-emerald-400 w-10 shrink-0">GET</span>
          <span class="text-gray-300">/api/health</span>
        </div>
        <div class="flex gap-3 items-center py-2 border-b border-gray-800">
          <span class="text-sky-400 w-10 shrink-0">POST</span>
          <span class="text-gray-300">/api/campaigns</span>
        </div>
        <div class="flex gap-3 items-center py-2 border-b border-gray-800">
          <span class="text-sky-400 w-10 shrink-0">POST</span>
          <span class="text-gray-300">/api/calls/:id/turns</span>
        </div>
        <div class="flex gap-3 items-center py-2">
          <span class="text-sky-400 w-10 shrink-0">POST</span>
          <span class="text-gray-300">/api/webhooks/exotel</span>
        </div>
      </div>
    </div>

  </div>

  <script>
    function dot(id, ok) {
      document.getElementById(id).className =
        'w-2.5 h-2.5 rounded-full mx-auto mb-2 transition-colors ' +
        (ok ? 'bg-emerald-400' : 'bg-red-400');
    }

    async function checkHealth() {
      try {
        const r = await fetch('/api/health');
        const d = await r.json();
        const badge = document.getElementById('badge');
        badge.textContent = 'online';
        badge.className = 'text-xs px-3 py-1 rounded-full bg-emerald-900/60 text-emerald-400 font-medium';
        dot('dot-api', true);
        dot('dot-db', d.details?.database === 'ok');
        dot('dot-redis', d.details?.redis === 'ok');
      } catch {
        const badge = document.getElementById('badge');
        badge.textContent = 'offline';
        badge.className = 'text-xs px-3 py-1 rounded-full bg-red-900/60 text-red-400 font-medium';
      }
    }

    async function triggerCall() {
      const token = document.getElementById('inp-token').value.trim();
      const phone = document.getElementById('inp-phone').value.trim();
      const name  = document.getElementById('inp-name').value.trim();
      const msg   = document.getElementById('call-msg');

      if (!token) return showMsg('Enter your API auth token.', 'warn');
      if (!phone) return showMsg('Enter a phone number.', 'warn');

      try {
        const r = await fetch('/api/campaigns', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': token,
          },
          body: JSON.stringify({ targets: [{ phone, name: name || 'Lead' }] }),
        });
        const d = await r.json();
        if (r.ok) {
          showMsg('Call queued — ' + JSON.stringify(d), 'ok');
        } else {
          showMsg((d.message || JSON.stringify(d)), 'err');
        }
      } catch (e) {
        showMsg(e.message, 'err');
      }
    }

    function showMsg(text, type) {
      const el = document.getElementById('call-msg');
      const styles = {
        ok:   'bg-emerald-900/40 text-emerald-400',
        err:  'bg-red-900/40 text-red-400',
        warn: 'bg-yellow-900/40 text-yellow-400',
      };
      el.className = 'mt-3 text-sm rounded-xl px-4 py-3 ' + styles[type];
      el.textContent = text;
      el.classList.remove('hidden');
    }

    checkHealth();
    setInterval(checkHealth, 30000);
  </script>
</body>
</html>`;
