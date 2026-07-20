const required = ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "OPENROUTER_API_KEY"];
const live = process.env.RUN_LIVE_PROVIDER_SMOKE === "true";

async function main() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing provider credentials: ${missing.join(", ")}`);
  }

  if (!live) {
    console.log(
      "Provider credentials are present. Set RUN_LIVE_PROVIDER_SMOKE=true to call provider auth endpoints.",
    );
    return;
  }

  const checks = [];
  checks.push(checkDeepgram());
  checks.push(checkElevenLabs());
  checks.push(checkOpenRouter());
  // Sarvam is the ONLY vendor that can speak Gujarati; without it `gu` silently
  // collapses to the Hindi persona (the isGujaratiEnabled kill switch), which is a
  // working call in every log and the wrong language to the caller. Not in
  // `required` — hi/en are fully functional without it.
  if (process.env.SARVAM_API_KEY) checks.push(checkSarvam());
  else console.warn("SARVAM_API_KEY unset — Gujarati will fall back to Hindi");

  const results = await Promise.allSettled(checks);
  const failed = results.filter((result) => result.status === "rejected");
  for (const result of results) {
    if (result.status === "fulfilled") console.log(result.value);
    else console.error(result.reason);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function checkDeepgram() {
  const res = await fetch("https://api.deepgram.com/v1/projects", {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Deepgram auth failed: ${res.status}`);
  return "Deepgram auth ok";
}

async function checkElevenLabs() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) throw new Error(`ElevenLabs auth failed: ${res.status}`);
  return "ElevenLabs auth ok";
}

async function checkOpenRouter() {
  const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4-5";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply OK." }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter smoke failed: ${res.status}`);
  return "OpenRouter auth ok";
}

async function checkSarvam() {
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "api-subscription-key": process.env.SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "નમસ્તે",
      target_language_code: "gu-IN",
      model: process.env.SARVAM_MODEL ?? "bulbul:v3",
      speaker: process.env.SARVAM_SPEAKER ?? "simran",
      speech_sample_rate: 8000,
    }),
  });
  if (!res.ok) throw new Error(`Sarvam auth failed: ${res.status} ${await res.text()}`);
  return "Sarvam auth ok (Gujarati available)";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
