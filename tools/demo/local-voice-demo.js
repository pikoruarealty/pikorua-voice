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
  const locale = process.env.CALL_LOCALE_DEFAULT || "hi-IN";
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
    wsUrl: `ws://localhost:${apiPort}/demo-voice`,
    token: process.env.API_AUTH_TOKEN || "",
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
  // Fragment-hold turns aren't persisted to the DB — fall back to the API payload.
  const transcript =
    turns.find((turn) => turn.role === "caller")?.content || apiPayload.transcript || "";
  const reply = turns.find((turn) => turn.role === "assistant")?.content || apiPayload.reply || "";

  console.log("");
  console.log(`call=${callId} turn=${turnIndex}`);
  console.log(`you: ${transcript || "(no transcript)"}`);
  console.log(`assistant: ${reply || "(no reply)"}`);

  return {
    turnIndex,
    transcript,
    reply,
    audioBase64: apiPayload.audioBase64,
    endCall: apiPayload.endCall === true,
    waitForMore: apiPayload.waitForMore === true,
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
      <p>Live streaming demo: your microphone streams continuously to the server, Deepgram detects when you finish speaking (thinking pauses won't cut you off), and you can interrupt the assistant mid-reply just by talking.</p>
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

    // Streaming mode: the mic stays open for the whole conversation and audio
    // is streamed to the server, where Deepgram decides utterance boundaries.
    // No client-side VAD — thinking pauses won't cut you off, and you can
    // interrupt the assistant mid-reply (barge-in).
    let session = null;
    let conversationActive = false;
    let ws = null;
    let assistantSpeaking = false;

    // Streaming playback: per-sentence audio chunks are assembled and queued
    // so the first sentence plays while later ones are still synthesizing.
    const sentenceChunks = new Map();
    let playQueue = [];
    let playing = false;
    let pendingEndCall = false;

    // mic state
    let audioContext = null;
    let stream = null;
    let source = null;
    let processor = null;
    let silentGain = null;
    let lastSamples = new Float32Array(0);
    let vadActive = false; // drives the waveform animation

    function setStatus(text, kind) {
      els.status.textContent = text;
      els.status.className = "status" + (kind ? " " + kind : "");
    }

    async function createSession() {
      setStatus("Creating session");
      const res = await fetch("/api/session");
      if (!res.ok) throw new Error(await res.text());
      session = await res.json();
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
      await openMic();
      connectSocket();
    }

    async function endConversation() {
      conversationActive = false;
      vadActive = false;
      assistantSpeaking = false;
      pendingEndCall = false;
      stopPlayback();
      if (ws) {
        try { ws.send(JSON.stringify({ type: "stop" })); } catch {}
        try { ws.close(); } catch {}
        ws = null;
      }
      teardownMic();
      els.start.disabled = false;
      els.stop.disabled = true;
      setStatus("Conversation ended");
      drawIdle();
    }

    // Open the mic once for the whole conversation and stream 16 kHz PCM16
    // to the server continuously. Utterance boundaries are decided server-side
    // by Deepgram's endpointing, not by client silence thresholds.
    async function openMic() {
      audioContext = new AudioContext();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(2048, 1, 1);
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        lastSamples = copy;
        // Mic streams CONTINUOUSLY — even while the assistant speaks — so the
        // server can detect barge-in. Browser echo cancellation keeps Maya's
        // own voice out of the stream; the server aborts and sends "cancel"
        // when real caller speech arrives mid-reply.
        if (ws && ws.readyState === WebSocket.OPEN) {
          const ds = downsampleTo16k(input, audioContext.sampleRate);
          ws.send(floatTo16BitPCM(ds).buffer);
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      vadActive = true;
      drawRecording();
    }

    function connectSocket() {
      const url = session.wsUrl + (session.token ? "?token=" + encodeURIComponent(session.token) : "");
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: "start",
          callId: session.callId,
          language: session.language,
          sampleRate: 16000,
          streaming: true,
        }));
        setStatus("Listening — speak naturally, short pauses are fine");
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        handleServerMessage(msg).catch((err) => setStatus(err.message, "error"));
      };
      ws.onerror = () => setStatus("Connection error", "error");
      ws.onclose = () => {
        if (conversationActive) {
          conversationActive = false;
          vadActive = false;
          teardownMic();
          els.start.disabled = false;
          els.stop.disabled = true;
          setStatus("Connection closed");
          drawIdle();
        }
      };
    }

    function enqueueAudio(bytes) {
      playQueue.push(bytes);
      if (!playing) void playNext();
    }

    async function playNext() {
      const next = playQueue.shift();
      if (!next) {
        playing = false;
        assistantSpeaking = false;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: "playback-done" })); } catch {}
        }
        if (pendingEndCall) {
          pendingEndCall = false;
          await endConversation();
          setStatus("Call complete — lead details collected");
        } else if (conversationActive) {
          setStatus("Listening");
        }
        return;
      }
      playing = true;
      assistantSpeaking = true;
      setStatus("Assistant speaking — you can interrupt");
      const blob = new Blob([next], { type: "audio/mpeg" });
      els.audio.src = URL.createObjectURL(blob);
      try {
        await new Promise((resolve, reject) => {
          els.audio.onended = resolve;
          els.audio.onerror = reject;
          els.audio.play().catch(reject);
        });
      } catch {
        setStatus("Tap play to hear the reply", "warn");
        await new Promise((resolve) => { els.audio.onended = resolve; });
      }
      void playNext();
    }

    // Server-authoritative barge-in / guardrail replacement: drop everything
    // queued or playing immediately.
    function stopPlayback() {
      playQueue = [];
      sentenceChunks.clear();
      try { els.audio.pause(); } catch {}
      playing = false;
      assistantSpeaking = false;
    }

    function handleAudioChunk(msg) {
      const idx = Number(msg.sentenceIndex ?? 0);
      if (!sentenceChunks.has(idx)) sentenceChunks.set(idx, []);
      if (msg.audioBase64) sentenceChunks.get(idx).push(base64ToArrayBuffer(msg.audioBase64));
      if (msg.last) {
        const parts = sentenceChunks.get(idx) || [];
        sentenceChunks.delete(idx);
        const total = parts.reduce((n, b) => n + b.byteLength, 0);
        if (total === 0) return;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          merged.set(new Uint8Array(part), offset);
          offset += part.byteLength;
        }
        enqueueAudio(merged);
      }
    }

    async function handleServerMessage(msg) {
      if (msg.type === "partial") {
        els.transcript.textContent = msg.transcript + " …";
        return;
      }
      if (msg.type === "holding") {
        els.transcript.textContent = (msg.transcript || "") + " …";
        setStatus("Listening — please continue");
        return;
      }
      if (msg.type === "turn-start") {
        els.transcript.textContent = msg.transcript || "";
        els.reply.textContent = "";
        setStatus("Thinking…");
        return;
      }
      if (msg.type === "reply-chunk") {
        els.reply.textContent = (els.reply.textContent ? els.reply.textContent + " " : "") + (msg.text || "");
        return;
      }
      if (msg.type === "filler") {
        // Latency mask — only play if nothing real has arrived yet.
        if (!playing && playQueue.length === 0 && msg.audioBase64) {
          enqueueAudio(new Uint8Array(base64ToArrayBuffer(msg.audioBase64)));
        }
        return;
      }
      if (msg.type === "audio-chunk") {
        handleAudioChunk(msg);
        return;
      }
      if (msg.type === "cancel") {
        stopPlayback();
        setStatus("Listening");
        return;
      }
      if (msg.type === "reply-end") {
        els.transcript.textContent = msg.transcript || "(no transcript)";
        if (msg.reply) els.reply.textContent = msg.reply;
        if (msg.endCall) {
          if (playing || playQueue.length > 0) pendingEndCall = true;
          else {
            await endConversation();
            setStatus("Call complete — lead details collected");
          }
        }
        return;
      }
      if (msg.type === "reply") {
        els.transcript.textContent = msg.transcript || "(no transcript)";
        els.reply.textContent = msg.reply || "(no reply)";
        const audioBytes = base64ToArrayBuffer(msg.audioBase64 || "");
        if (audioBytes.byteLength > 0) {
          const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
          els.audio.src = URL.createObjectURL(audioBlob);
          assistantSpeaking = true;
          setStatus("Assistant speaking — you can interrupt");
          try {
            await new Promise((resolve, reject) => {
              els.audio.onended = resolve;
              els.audio.onerror = reject;
              els.audio.play().catch(reject);
            });
          } catch {
            setStatus("Tap play to hear the reply", "warn");
            await new Promise((resolve) => {
              els.audio.onended = resolve;
            });
          }
          assistantSpeaking = false;
        }
        if (msg.endCall) {
          await endConversation();
          setStatus("Call complete — lead details collected");
          return;
        }
        if (conversationActive) setStatus("Listening");
        return;
      }
      if (msg.type === "error") {
        setStatus(msg.message || "Server error", "error");
      }
    }

    function teardownMic() {
      if (processor) { try { processor.disconnect(); } catch {} processor = null; }
      if (source) { try { source.disconnect(); } catch {} source = null; }
      if (silentGain) { try { silentGain.disconnect(); } catch {} silentGain = null; }
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    }

    // Linear-interpolation resample to 16 kHz for the streaming socket
    function downsampleTo16k(input, fromRate) {
      if (fromRate === 16000) return input;
      const ratio = fromRate / 16000;
      const outLen = Math.floor(input.length / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i += 1) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = pos - i0;
        out[i] = input[i0] * (1 - frac) + input[i1] * frac;
      }
      return out;
    }

    function floatTo16BitPCM(float32) {
      const out = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i += 1) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
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
