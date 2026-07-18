export const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pikorua Voice Demo</title>
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
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
    p { margin: 0; color: var(--muted); line-height: 1.5; font-size: 14px; }
    .meta { margin-top: 24px; display: grid; gap: 12px; font-size: 13px; }
    .meta div { display: grid; gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
    .meta span { color: var(--muted); }
    code { font-family: "SFMono-Regular", Consolas, monospace; word-break: break-all; color: var(--ink); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
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
    button.primary { border-color: var(--accent); background: var(--accent); color: var(--white); }
    button.primary:hover { background: var(--accent-dark); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
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
    .wave { width: 100%; height: 180px; border: 1px solid var(--line); border-radius: 8px; background: #111827; display: block; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .panel { background: var(--white); border: 1px solid var(--line); border-radius: 8px; padding: 18px; min-height: 180px; }
    .panel h2 { margin: 0 0 12px; font-size: 15px; }
    .panel pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: var(--ink); }
    audio { width: 100%; margin-top: 14px; }
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
      <h1>Pikorua Voice Demo</h1>
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

    let session = null;
    let conversationActive = false;
    let ws = null;
    let assistantSpeaking = false;

    const sentenceChunks = new Map();
    let playQueue = [];
    let playing = false;
    let pendingEndCall = false;

    let audioContext = null;
    let stream = null;
    let source = null;
    let processor = null;
    let silentGain = null;
    let lastSamples = new Float32Array(0);
    let vadActive = false;

    function setStatus(text, kind) {
      els.status.textContent = text;
      els.status.className = "status" + (kind ? " " + kind : "");
    }

    async function createSession() {
      setStatus("Creating session");
      // Pass ?locale= through from the page URL so a Gujarati/English demo can be
      // requested (e.g. /?locale=gu-IN) without changing the server default.
      const pageLocale = new URLSearchParams(location.search).get("locale");
      const res = await fetch("/api/demo/session" + (pageLocale ? "?locale=" + encodeURIComponent(pageLocale) : ""));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      // Derive WebSocket URL from the current page host
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      session = {
        callId: data.callId,
        language: data.language,
        token: data.token,
        wsUrl: proto + "//" + location.host + "/demo-voice",
        apiBaseUrl: location.origin + "/api",
      };
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
      // Unlock audio playback within the user-gesture stack frame so the
      // browser's autoplay policy doesn't block Maya's greeting audio.
      // Use a silent data URI — setting src="" throws on some browsers.
      els.audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      try { await els.audio.play(); } catch {}
      els.audio.pause();
      els.audio.src = "";
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

    async function openMic() {
      audioContext = new AudioContext();
      // Create the playback context now, inside the click gesture, so autoplay
      // policy lets the first Gujarati audio play without a second interaction.
      if (isGuSession() && !pcmCtx) {
        pcmCtx = new (window.AudioContext || window.webkitAudioContext)();
        pcmNextTime = pcmCtx.currentTime;
      }
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
        setStatus("Maya is connecting…");
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

    // Pick the MIME type from the bytes, not the language: "RIFF" → WAV (Sarvam),
    // otherwise MP3 (ElevenLabs). Content-sniffing means the demo doesn't need to
    // know which TTS engine produced the reply.
    function audioMimeType(bytes) {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const isRiff = b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
      return isRiff ? "audio/wav" : "audio/mpeg";
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
      // Sniff the container: ElevenLabs (hi/en) streams MP3; Sarvam (gu) returns
      // WAV, which starts with the ASCII "RIFF" magic. Labelling WAV as audio/mpeg
      // left Gujarati replies silent — the <audio> element couldn't decode them.
      const blob = new Blob([next], { type: audioMimeType(next) });
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

    function stopPlayback() {
      playQueue = [];
      sentenceChunks.clear();
      try { els.audio.pause(); } catch {}
      playing = false;
      assistantSpeaking = false;
      pcmStop();
    }

    // ── Streaming PCM player (Gujarati / Sarvam path) ─────────────────────────
    // Sarvam streams raw s16le 8 kHz PCM as the reply is synthesised. Play each
    // chunk the instant it arrives via Web Audio, rather than buffering a whole
    // sentence into an <audio> element — so Maya's voice starts as soon as the
    // reply text does, with no per-sentence lag. Chunks are raw PCM (turn WS
    // session) or a buffered WAV (greeting/fallback); a RIFF header is stripped.
    let pcmCtx = null;
    let pcmNextTime = 0;
    let pcmSources = [];
    let pcmDraining = false;
    // Trailing byte of the previous chunk when it ended mid-sample. Carried into
    // the next chunk so 16-bit samples never straddle a chunk boundary — a 1-byte
    // misalignment turns every following sample into loud buzz, not a soft click.
    let pcmResidual = null;

    function isGuSession() {
      return !!(session && String(session.language || "").toLowerCase().startsWith("gu"));
    }

    function pcmPush(rawBytes) {
      if (!pcmCtx) pcmCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (pcmCtx.state === "suspended") pcmCtx.resume().catch(() => {});
      let bytes = rawBytes;
      let off = 0;
      // "RIFF" → skip the 44-byte WAV header (buffered greeting/fallback chunks).
      if (bytes.length >= 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) off = 44;
      // Prepend any leftover odd byte from the previous chunk so sample framing
      // stays aligned across the boundary.
      if (pcmResidual && pcmResidual.length) {
        const tail = bytes.subarray(off);
        const merged = new Uint8Array(pcmResidual.length + tail.length);
        merged.set(pcmResidual, 0);
        merged.set(tail, pcmResidual.length);
        bytes = merged;
        off = 0;
      }
      pcmResidual = null;
      const avail = bytes.length - off;
      const n = avail >> 1;
      // Stash a trailing odd byte (a sample split across this chunk and the next).
      if (avail & 1) pcmResidual = new Uint8Array(bytes.subarray(off + n * 2));
      if (n <= 0) return;
      const buf = pcmCtx.createBuffer(1, n, 8000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        let s = (bytes[off + i * 2 + 1] << 8) | bytes[off + i * 2];
        if (s >= 32768) s -= 65536;
        ch[i] = s / 32768;
      }
      const src = pcmCtx.createBufferSource();
      src.buffer = buf;
      src.connect(pcmCtx.destination);
      // Schedule back-to-back for gapless playback; if chunks fall behind
      // realtime (network stall) restart from now so there's no long silence.
      const at = Math.max(pcmCtx.currentTime + 0.02, pcmNextTime);
      src.start(at);
      pcmNextTime = at + buf.duration;
      pcmSources.push(src);
      assistantSpeaking = true;
      src.onended = () => {
        pcmSources = pcmSources.filter((s) => s !== src);
        if (pcmSources.length === 0 && pcmDraining) pcmFinished();
      };
    }

    function pcmFinished() {
      pcmDraining = false;
      pcmResidual = null;
      assistantSpeaking = false;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "playback-done" })); } catch {}
      }
      if (pendingEndCall) {
        pendingEndCall = false;
        void endConversation().then(() => setStatus("Call complete — lead details collected"));
      } else if (conversationActive) {
        setStatus("Listening");
      }
    }

    // Called when the turn's audio is fully sent (reply-end/greeting-end): once
    // the scheduled buffers finish, report playback-done.
    function pcmMarkTurnEnd() {
      if (pcmSources.length === 0) pcmFinished();
      else pcmDraining = true;
    }

    function pcmStop() {
      for (const s of pcmSources) { try { s.stop(); } catch {} }
      pcmSources = [];
      pcmDraining = false;
      pcmResidual = null;
      pcmNextTime = pcmCtx ? pcmCtx.currentTime : 0;
    }

    function handleAudioChunk(msg) {
      // Gujarati: stream every chunk straight to the PCM player as it arrives —
      // no per-sentence buffering, so audio tracks the reply text with no lag.
      if (isGuSession()) {
        if (msg.audioBase64) {
          pcmPush(new Uint8Array(base64ToArrayBuffer(msg.audioBase64)));
          if (assistantSpeaking) setStatus("Assistant speaking — you can interrupt");
        }
        return;
      }
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
        for (const part of parts) { merged.set(new Uint8Array(part), offset); offset += part.byteLength; }
        enqueueAudio(merged);
      }
    }

    async function handleServerMessage(msg) {
      if (msg.type === "partial") { els.transcript.textContent = msg.transcript + " …"; return; }
      if (msg.type === "holding") { els.transcript.textContent = (msg.transcript || "") + " …"; setStatus("Listening — please continue"); return; }
      if (msg.type === "turn-start") { els.transcript.textContent = msg.transcript || ""; els.reply.textContent = ""; setStatus(msg.transcript ? "Thinking…" : "Maya is connecting…"); return; }
      if (msg.type === "greeting-end") { if (msg.reply) els.reply.textContent = msg.reply; if (isGuSession()) pcmMarkTurnEnd(); else setStatus("Listening — speak naturally, short pauses are fine"); return; }
      if (msg.type === "reply-chunk") { els.reply.textContent = (els.reply.textContent ? els.reply.textContent + " " : "") + (msg.text || ""); return; }
      if (msg.type === "filler") {
        if (!playing && playQueue.length === 0 && msg.audioBase64) enqueueAudio(new Uint8Array(base64ToArrayBuffer(msg.audioBase64)));
        return;
      }
      if (msg.type === "audio-chunk") { handleAudioChunk(msg); return; }
      if (msg.type === "cancel") { stopPlayback(); setStatus("Listening"); return; }
      if (msg.type === "reply-end") {
        els.transcript.textContent = msg.transcript || "(no transcript)";
        if (msg.reply) els.reply.textContent = msg.reply;
        if (isGuSession()) {
          // PCM is still playing out; defer end-call until the buffers drain.
          if (msg.endCall) pendingEndCall = true;
          if (!msg.canceled) pcmMarkTurnEnd();
          return;
        }
        if (msg.endCall) {
          if (playing || playQueue.length > 0) pendingEndCall = true;
          else { await endConversation(); setStatus("Call complete — lead details collected"); }
        }
        return;
      }
      if (msg.type === "reply") {
        els.transcript.textContent = msg.transcript || "(no transcript)";
        els.reply.textContent = msg.reply || "(no reply)";
        const audioBytes = base64ToArrayBuffer(msg.audioBase64 || "");
        if (audioBytes.byteLength > 0) {
          const audioBlob = new Blob([audioBytes], { type: audioMimeType(new Uint8Array(audioBytes)) });
          els.audio.src = URL.createObjectURL(audioBlob);
          assistantSpeaking = true;
          setStatus("Assistant speaking — you can interrupt");
          try {
            await new Promise((resolve, reject) => { els.audio.onended = resolve; els.audio.onerror = reject; els.audio.play().catch(reject); });
          } catch {
            setStatus("Tap play to hear the reply", "warn");
            await new Promise((resolve) => { els.audio.onended = resolve; });
          }
          assistantSpeaking = false;
        }
        if (msg.endCall) { await endConversation(); setStatus("Call complete — lead details collected"); return; }
        if (conversationActive) setStatus("Listening");
        return;
      }
      if (msg.type === "error") setStatus(msg.message || "Server error", "error");
    }

    function teardownMic() {
      if (processor) { try { processor.disconnect(); } catch {} processor = null; }
      if (source) { try { source.disconnect(); } catch {} source = null; }
      if (silentGain) { try { silentGain.disconnect(); } catch {} silentGain = null; }
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    }

    function downsampleTo16k(input, fromRate) {
      if (fromRate === 16000) return input;
      const ratio = fromRate / 16000;
      const outLen = Math.floor(input.length / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
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
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    function base64ToArrayBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    function drawIdle() {
      const ctx = els.wave.getContext("2d");
      ctx.clearRect(0, 0, els.wave.width, els.wave.height);
      ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, els.wave.width, els.wave.height);
      ctx.strokeStyle = "#5eead4"; ctx.lineWidth = 3; ctx.beginPath();
      const mid = els.wave.height / 2;
      for (let x = 0; x < els.wave.width; x += 8) {
        const y = mid + Math.sin(x / 34) * 18;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    function drawRecording() {
      const ctx = els.wave.getContext("2d");
      ctx.clearRect(0, 0, els.wave.width, els.wave.height);
      ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, els.wave.width, els.wave.height);
      ctx.strokeStyle = "#34d399"; ctx.lineWidth = 2; ctx.beginPath();
      const data = lastSamples.length ? lastSamples : new Float32Array(512);
      const step = Math.max(1, Math.floor(data.length / els.wave.width));
      const mid = els.wave.height / 2;
      for (let x = 0; x < els.wave.width; x++) {
        const sample = data[Math.min(data.length - 1, x * step)] || 0;
        const y = mid + sample * mid * 0.82;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
