# Media Ingress Gateway

WebSocket endpoint: `/media-ingress`

Messages

- `{"type":"start","callId":"...","language":"hi-IN","turnIndex":0}` begins buffering for a call.
- `{"type":"media","payload":"<base64 audio>"}` appends an audio frame.
- `{"type":"stop"}` processes the buffered audio.

When `callId` is present, `stop` runs the same STT → LLM → TTS runtime path as the HTTP turn endpoint and returns `{"type":"response","transcript":"...","reply":"...","audioBase64":"..."}`. Without a `callId`, it falls back to transcript-only mode and returns `{"type":"transcript", ...}`.
