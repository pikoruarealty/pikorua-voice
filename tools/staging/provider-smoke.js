const required = ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"];
const llmSatisfied = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
);
const live = process.env.RUN_LIVE_PROVIDER_SMOKE === "true";

async function main() {
  const missing = required.filter((key) => !process.env[key]);
  if (!llmSatisfied) {
    missing.push("ANTHROPIC_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY");
  }
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
  if (process.env.ANTHROPIC_API_KEY) checks.push(checkAnthropic());
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) checks.push(checkGoogle());

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

async function checkAnthropic() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply OK." }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic smoke failed: ${res.status}`);
  return "Anthropic smoke ok";
}

async function checkGoogle() {
  const model = process.env.GOOGLE_MODEL ?? "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply OK." }] }] }),
  });
  if (!res.ok) throw new Error(`Google smoke failed: ${res.status}`);
  return "Google smoke ok";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
