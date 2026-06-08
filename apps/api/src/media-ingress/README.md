# Media Ingress Gateway

WebSocket endpoint: `/media-ingress`

Messages
- `{"type":"start","callId":"...","language":"hi-IN"}` begins buffering for a call.
- `{"type":"media","payload":"<base64 audio>"}` appends an audio frame.
- `{"type":"stop"}` transcribes the buffered audio and returns `{"type":"transcript", ...}`.

This gateway is intentionally lightweight and reuses the existing Deepgram realtime helper so the API can accept provider-style media frames without a separate media server.
