const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
loadDotEnv(path.join(root, ".env"));

const port = Number(process.env.DEMO_PORT || 4173);

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDemoSession() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create a local voice demo session");
  }

  const callId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  const locale = process.env.GEMINI_LANGUAGE_DEFAULT || "hi-IN";
  const sid = `local-demo-${Date.now()}`;

  const sql = `
INSERT INTO campaigns (id, name, status, default_locale, notes)
VALUES (${sqlString(campaignId)}, 'Local Voice Demo', 'draft', ${sqlString(locale)}, 'Local browser microphone demo')
ON CONFLICT DO NOTHING;

INSERT INTO campaign_targets (id, campaign_id, phone, full_name, locale)
VALUES (${sqlString(targetId)}, ${sqlString(campaignId)}, '+910000000000', 'Local Demo Caller', ${sqlString(locale)})
ON CONFLICT DO NOTHING;

INSERT INTO calls (id, campaign_id, target_id, provider_call_sid, status, from_number, to_number, locale)
VALUES (${sqlString(callId)}, ${sqlString(campaignId)}, ${sqlString(targetId)}, ${sqlString(sid)}, 'in_progress', '+910000000000', '+910000000001', ${sqlString(locale)})
ON CONFLICT DO NOTHING;
`;

  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-d", databaseUrl, "-c", sql], {
    stdio: "pipe",
  });

  const apiPort = Number(process.env.API_PORT || 4100);
  return {
    callId,
    language: locale,
    apiBaseUrl: `http://localhost:${apiPort}/api`,
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function processTurn(body) {
  const callId = String(body.callId || "");
  const turnIndex = Number(body.turnIndex || 0);
  const audioBase64 = String(body.audioBase64 || "");
  if (!callId || !audioBase64) {
    throw new Error("callId and audioBase64 are required");
  }

  const apiPort = Number(process.env.API_PORT || 4100);
  const apiBaseUrl = `http://localhost:${apiPort}/api`;
  const headers = { "content-type": "application/json" };
  if (process.env.API_AUTH_TOKEN) {
    headers["x-api-key"] = process.env.API_AUTH_TOKEN;
  }

  const res = await fetch(`${apiBaseUrl}/calls/${encodeURIComponent(callId)}/turns`, {
    method: "POST",
    headers,
    body: JSON.stringify({ turnIndex, audioBase64 }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API turn failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const apiPayload = text ? JSON.parse(text) : {};
  const turns = readTurns(callId, turnIndex);
  const transcript = turns.find((turn) => turn.role === "caller")?.content || "";
  const reply = turns.find((turn) => turn.role === "assistant")?.content || "";

  console.log("");
  console.log(`call=${callId} turn=${turnIndex}`);
  console.log(`you: ${transcript || "(no transcript)"}`);
  console.log(`assistant: ${reply || "(no reply)"}`);

  return {
    turnIndex,
    transcript,
    reply,
    audioBase64: apiPayload.audioBase64,
  };
}

function readTurns(callId, turnIndex) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to read local demo turns");
  }

  const callerIndex = turnIndex * 2;
  const assistantIndex = callerIndex + 1;
  const query = `
SELECT COALESCE(
  json_agg(json_build_object('turnIndex', turn_index, 'role', role, 'content', content) ORDER BY turn_index),
  '[]'::json
)
FROM call_turns
WHERE call_id = ${sqlString(callId)}
  AND turn_index IN (${callerIndex}, ${assistantIndex});
`;
  const output = execFileSync("psql", ["-At", "-d", databaseUrl, "-c", query], {
    encoding: "utf8",
  }).trim();
  return JSON.parse(output || "[]");
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pikorua Local Voice Demo</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #202124;
      --muted: #626a73;
      --line: #d8dde3;
      --panel: #f6f8fb;
      --accent: #116b5f;
      --accent-dark: #0d5047;
      --danger: #9b2430;
      --warm: #8a5b13;
      --white: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: #eef2f6;
    }
    main {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
    }
    aside {
      background: var(--white);
      border-right: 1px solid var(--line);
      padding: 28px;
      display: flex;
      flex-direction: column;
    }
    section {
      padding: 28px;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 18px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
      font-size: 14px;
    }
    .meta {
      margin-top: 24px;
      display: grid;
      gap: 12px;
      font-size: 13px;
    }
    .meta div {
      display: grid;
      gap: 4px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }
    .meta span {
      color: var(--muted);
    }
    code {
      font-family: "SFMono-Regular", Consolas, monospace;
      word-break: break-all;
      color: var(--ink);
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    button {
      min-height: 42px;
      border: 1px solid var(--line);
      background: var(--white);
      color: var(--ink);
      border-radius: 7px;
      padding: 0 14px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--white);
    }
    button.primary:hover { background: var(--accent-dark); }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .status {
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 0 12px;
      background: var(--white);
      color: var(--muted);
      font-size: 14px;
    }
    .wave {
      width: 100%;
      height: 180px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #111827;
      display: block;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }
    .panel {
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      min-height: 180px;
    }
    .panel h2 {
      margin: 0 0 12px;
      font-size: 15px;
      letter-spacing: 0;
    }
    .panel pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
      color: var(--ink);
    }
    audio {
      width: 100%;
      margin-top: 14px;
    }
    .error { color: var(--danger); }
    .warn { color: var(--warm); }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <aside>
      <h1>Pikorua Local Voice Demo</h1>
      <p>Record one turn from your microphone, send it through Deepgram, Google/Anthropic, and ElevenLabs, then play the assistant response. The terminal prints each transcript and reply.</p>
      <div class="meta">
        <div><span>Call ID</span><code id="callId">creating...</code></div>
        <div><span>Language</span><code id="language">...</code></div>
        <div><span>Runtime endpoint</span><code id="endpoint">...</code></div>
      </div>
    </aside>
    <section>
      <div class="toolbar">
        <button id="newSession">New Session</button>
        <button id="start" class="primary">Start Conversation</button>
        <button id="stop" disabled>End Conversation</button>
        <span id="status" class="status">Preparing session</span>
      </div>
      <canvas id="wave" class="wave" width="1200" height="260"></canvas>
      <div class="grid">
        <div class="panel">
          <h2>You Said</h2>
          <pre id="transcript">Nothing yet.</pre>
        </div>
        <div class="panel">
          <h2>Assistant</h2>
          <pre id="reply">Waiting for your first turn.</pre>
          <audio id="audio" controls></audio>
        </div>
      </div>
    </section>
  </main>
  <script>
    const els = {
      callId: document.getElementById("callId"),
      language: document.getElementById("language"),
      endpoint: document.getElementById("endpoint"),
      status: document.getElementById("status"),
      start: document.getElementById("start"),
      stop: document.getElementById("stop"),
      newSession: document.getElementById("newSession"),
      transcript: document.getElementById("transcript"),
      reply: document.getElementById("reply"),
      audio: document.getElementById("audio"),
      wave: document.getElementById("wave"),
    };

    // VAD config — tune these if your mic is noisy or too sensitive
    const VAD_SILENCE_THRESHOLD = 0.03;   // RMS below this = silence (raise if triggering on noise)
    const VAD_SILENCE_MS = 1400;          // ms of silence before auto-send
    const VAD_MIN_SPEECH_MS = 600;        // ignore clips shorter than this

    let session = null;
    let turnIndex = 0;
    let conversationActive = false;

    // per-turn state
    let audioContext = null;
    let stream = null;
    let source = null;
    let processor = null;
    let silentGain = null;
    let chunks = [];
    let lastSamples = new Float32Array(0);
    let speechStarted = false;
    let speechStartTime = 0;
    let silenceStart = null;
    let vadActive = false;

    function setStatus(text, kind) {
      els.status.textContent = text;
      els.status.className = "status" + (kind ? " " + kind : "");
    }

    async function createSession() {
      setStatus("Creating session");
      const res = await fetch("/api/session");
      if (!res.ok) throw new Error(await res.text());
      session = await res.json();
      turnIndex = 0;
      els.callId.textContent = session.callId;
      els.language.textContent = session.language;
      els.endpoint.textContent = session.apiBaseUrl;
      els.transcript.textContent = "Nothing yet.";
      els.reply.textContent = "Waiting for your first turn.";
      els.audio.removeAttribute("src");
      setStatus("Ready — click Start Conversation");
      drawIdle();
    }

    async function startConversation() {
      if (!session) await createSession();
      conversationActive = true;
      els.start.disabled = true;
      els.stop.disabled = false;
      await listenForTurn();
    }

    async function endConversation() {
      conversationActive = false;
      vadActive = false;
      teardownMic();
      els.start.disabled = false;
      els.stop.disabled = true;
      setStatus("Conversation ended");
      drawIdle();
    }

    async function listenForTurn() {
      if (!conversationActive) return;

      chunks = [];
      speechStarted = false;
      speechStartTime = 0;
      silenceStart = null;
      vadActive = true;

      audioContext = new AudioContext();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(2048, 1, 1);
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (!vadActive) return;
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        lastSamples = copy;

        // compute RMS
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);

        const now = performance.now();

        if (rms > VAD_SILENCE_THRESHOLD) {
          // sound detected
          if (!speechStarted) {
            speechStarted = true;
            speechStartTime = now;
            setStatus("Listening — speak now");
          }
          silenceStart = null;
          chunks.push(copy);
        } else {
          // silence
          if (speechStarted) {
            chunks.push(copy); // keep trailing silence for natural audio
            if (silenceStart === null) silenceStart = now;
            const silenceDuration = now - silenceStart;
            const speechDuration = silenceStart - speechStartTime;
            if (silenceDuration >= VAD_SILENCE_MS && speechDuration >= VAD_MIN_SPEECH_MS) {
              // enough speech + enough silence = auto send
              vadActive = false;
              triggerSend();
            }
          }
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      setStatus("Listening — waiting for you to speak");
      drawRecording();
    }

    async function triggerSend() {
      setStatus("Processing your speech");

      const nativeSampleRate = audioContext.sampleRate;
      const targetSampleRate = 16000;

      // Merge all chunks into one float array
      const totalSamples = chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }

      // Downsample to 16kHz using OfflineAudioContext to keep payload small
      let downsampled = merged;
      if (nativeSampleRate !== targetSampleRate) {
        const offlineCtx = new OfflineAudioContext(
          1,
          Math.ceil(merged.length * targetSampleRate / nativeSampleRate),
          targetSampleRate,
        );
        const buf = offlineCtx.createBuffer(1, merged.length, nativeSampleRate);
        buf.copyToChannel(merged, 0);
        const src = offlineCtx.createBufferSource();
        src.buffer = buf;
        src.connect(offlineCtx.destination);
        src.start();
        const rendered = await offlineCtx.startRendering();
        downsampled = rendered.getChannelData(0);
      }

      const wav = encodeWav([downsampled], targetSampleRate);
      teardownMic();
      await sendTurn(wav);
    }

    function teardownMic() {
      if (processor) { try { processor.disconnect(); } catch {} processor = null; }
      if (source) { try { source.disconnect(); } catch {} source = null; }
      if (silentGain) { try { silentGain.disconnect(); } catch {} silentGain = null; }
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    }

    async function sendTurn(wavBuffer) {
      try {
        setStatus("Thinking");
        const res = await fetch("/api/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId: session.callId,
            turnIndex,
            audioBase64: arrayBufferToBase64(wavBuffer),
          }),
        });
        const payload = await res.json();
        if (!res.ok) {
          throw new Error(payload.error || "Voice runtime failed");
        }

        turnIndex = Number(payload.turnIndex || turnIndex) + 1;
        els.transcript.textContent = payload.transcript || "(no transcript)";
        els.reply.textContent = payload.reply || "(no reply)";

        const audioBytes = base64ToArrayBuffer(payload.audioBase64);
        const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
        const audioUrl = URL.createObjectURL(audioBlob);
        els.audio.src = audioUrl;

        setStatus("Assistant speaking");
        drawIdle();

        try {
          await new Promise((resolve, reject) => {
            els.audio.onended = resolve;
            els.audio.onerror = reject;
            els.audio.play().catch(reject);
          });
        } catch {
          setStatus("Tap play to hear reply, then conversation resumes", "warn");
          await new Promise((resolve) => {
            els.audio.onended = resolve;
          });
        }

        // end_call action from LLM — details collected, close conversation
        if (payload.endCall) {
          conversationActive = false;
          els.start.disabled = false;
          els.stop.disabled = true;
          setStatus("Call complete — lead details collected");
          return;
        }

        // after reply finishes, auto-listen again
        if (conversationActive) {
          await listenForTurn();
        }
      } catch (err) {
        setStatus(err.message, "error");
        // on error, still try to keep conversation going after a moment
        if (conversationActive) {
          setTimeout(() => listenForTurn().catch(() => {}), 2000);
        }
        throw err;
      }
    }

    function encodeWav(buffers, sampleRate) {
      const sampleCount = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      const data = new Float32Array(sampleCount);
      let offset = 0;
      for (const buffer of buffers) {
        data.set(buffer, offset);
        offset += buffer.length;
      }

      const out = new ArrayBuffer(44 + data.length * 2);
      const view = new DataView(out);
      writeString(view, 0, "RIFF");
      view.setUint32(4, 36 + data.length * 2, true);
      writeString(view, 8, "WAVE");
      writeString(view, 12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(view, 36, "data");
      view.setUint32(40, data.length * 2, true);

      let pos = 44;
      for (let i = 0; i < data.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, data[i]));
        view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        pos += 2;
      }
      return out;
    }

    function writeString(view, offset, value) {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const size = 0x8000;
      for (let i = 0; i < bytes.length; i += size) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + size));
      }
      return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    function drawIdle() {
      const ctx = els.wave.getContext("2d");
      ctx.clearRect(0, 0, els.wave.width, els.wave.height);
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, els.wave.width, els.wave.height);
      ctx.strokeStyle = "#5eead4";
      ctx.lineWidth = 3;
      ctx.beginPath();
      const mid = els.wave.height / 2;
      for (let x = 0; x < els.wave.width; x += 8) {
        const y = mid + Math.sin(x / 34) * 18;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    function drawRecording() {
      const ctx = els.wave.getContext("2d");
      ctx.clearRect(0, 0, els.wave.width, els.wave.height);
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, els.wave.width, els.wave.height);
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const data = lastSamples.length ? lastSamples : new Float32Array(512);
      const step = Math.max(1, Math.floor(data.length / els.wave.width));
      const mid = els.wave.height / 2;
      for (let x = 0; x < els.wave.width; x += 1) {
        const sample = data[Math.min(data.length - 1, x * step)] || 0;
        const y = mid + sample * mid * 0.82;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (vadActive) requestAnimationFrame(drawRecording);
    }

    els.start.addEventListener("click", () => startConversation().catch((err) => setStatus(err.message, "error")));
    els.stop.addEventListener("click", () => endConversation().catch((err) => console.error(err)));
    els.newSession.addEventListener("click", () => createSession().catch((err) => setStatus(err.message, "error")));
    createSession().catch((err) => setStatus(err.message, "error"));
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && req.url === "/api/session") {
      const session = createDemoSession();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(session));
      return;
    }

    if (req.method === "POST" && req.url === "/api/turn") {
      const body = await readJson(req);
      const payload = await processTurn(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(port, () => {
  console.log(`Local voice demo: http://localhost:${port}`);
  console.log("Keep the API running on API_PORT before recording.");
});
