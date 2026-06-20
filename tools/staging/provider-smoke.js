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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
