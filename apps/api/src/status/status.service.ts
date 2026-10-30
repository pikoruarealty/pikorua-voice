import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import type { CallSlots } from "@pikorua/shared";
import { HealthService } from "../health/health.service";
import { LlmService } from "../llm/llm.service";
import { TtsRouter } from "../tts/tts-router";
import { ClipLibrary } from "../tts/clip-library";
import { CALL_SLOTS } from "../redis/redis.module";

// Operator status for the /status dashboard: is every service Maya depends on
// reachable, authorised and funded? "warn" = working but running low; "error" =
// calls will fail or fall back. Read-only account endpoints where the vendor has
// one; Sarvam has no balance API, so it gets a 2-character synthesis (≈ ₹0.0006).
// Results are cached for CACHE_MS so a refreshing browser can't hammer vendors.

export type CheckLevel = "ok" | "warn" | "error" | "off";
export type Check = { name: string; level: CheckLevel; detail: string };

const CACHE_MS = 60_000;
const TIMEOUT_MS = 6_000;
const OPENROUTER_WARN_USD = 2;
const ELEVENLABS_WARN_CHARS = 2_000;

@Injectable()
export class StatusService {
  private cached: { at: number; body: unknown } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly health: HealthService,
    private readonly llm: LlmService,
    private readonly tts: TtsRouter,
    private readonly clips: ClipLibrary,
    @Inject(CALL_SLOTS) private readonly slots: CallSlots | null,
  ) {}

  async status(force = false) {
    // A forced refresh still reuses a result under 10 s old, so repeated clicks
    // can't spam the vendors (Sarvam's check is a real, if tiny, synthesis).
    const maxAge = force ? 10_000 : CACHE_MS;
    if (this.cached && Date.now() - this.cached.at < maxAge) return this.cached.body;
    const checks = await Promise.all([
      this.infra(),
      this.openrouter(),
      this.sarvam(),
      this.elevenlabs(),
      this.deepgram(),
      this.exotel(),
    ]);
    const flat = checks.flat();
    const level: CheckLevel = flat.some((c) => c.level === "error")
      ? "error"
      : flat.some((c) => c.level === "warn")
        ? "warn"
        : "ok";
    const body = {
      level,
      checkedAt: new Date().toISOString(),
      checks: flat,
      runtime: await this.runtime(),
    };
    this.cached = { at: Date.now(), body };
    return body;
  }

  private get(key: string): string {
    return String(this.config.get(key) ?? "");
  }

  private async infra(): Promise<Check[]> {
    const h = await this.health.check();
    const probe = (name: string, v: unknown): Check =>
      v === "ok"
        ? { name, level: "ok", detail: "connected" }
        : { name, level: "error", detail: String((v as { error?: string })?.error ?? v) };
    return [probe("Database", h.details.database), probe("Redis", h.details.redis)];
  }

  private async openrouter(): Promise<Check> {
    const name = "OpenRouter (AI replies)";
    const key = this.get("OPENROUTER_API_KEY");
    if (!key) return { name, level: "error", detail: "OPENROUTER_API_KEY not set — Maya cannot reply" };
    return attempt(name, async () => {
      const r = await axios.get("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${key}` },
        timeout: TIMEOUT_MS,
      });
      const left = Number(r.data?.data?.total_credits ?? 0) - Number(r.data?.data?.total_usage ?? 0);
      const detail = `$${left.toFixed(2)} credit left · model ${this.get("OPENROUTER_MODEL")}`;
      if (left <= 0.05) return { name, level: "error", detail: `${detail} — top up: replies will fail` };
      if (left < OPENROUTER_WARN_USD) return { name, level: "warn", detail: `${detail} — top up soon` };
      return { name, level: "ok", detail };
    });
  }

  private async sarvam(): Promise<Check> {
    const name = "Sarvam (voice + speech-to-text)";
    const key = this.get("SARVAM_API_KEY");
    if (!key) return { name, level: "error", detail: "SARVAM_API_KEY not set — ElevenLabs/Deepgram fallbacks in use" };
    const breakerMs = this.tts.sarvamBreakerOpenForMs();
    return attempt(name, async () => {
      await axios.post(
        "https://api.sarvam.ai/text-to-speech",
        {
          text: "जी",
          target_language_code: "hi-IN",
          speaker: this.get("SARVAM_SPEAKER_HI") || "aparna_hi_customer",
          model: this.get("SARVAM_TTS_MODEL") || "bulbul:v4-flash",
          speech_sample_rate: 8000,
        },
        { headers: { "api-subscription-key": key }, timeout: TIMEOUT_MS },
      );
      const using = `voice ${this.get("TTS_PROVIDER_HI") === "elevenlabs" ? "ElevenLabs (hi/en)" : "Sarvam"} · STT ${this.get("STT_PROVIDER") === "deepgram" ? "Deepgram" : "Sarvam"}`;
      if (breakerMs > 0)
        return {
          name,
          level: "warn",
          detail: `key works now, but a recent failure has calls on ElevenLabs for ${Math.ceil(breakerMs / 60000)} more min · ${using}`,
        };
      return { name, level: "ok", detail: `key and credits OK · ${using}` };
    });
  }

  private async elevenlabs(): Promise<Check> {
    const name = "ElevenLabs (voice fallback)";
    const key = this.get("ELEVENLABS_API_KEY");
    if (!key) return { name, level: "warn", detail: "not set — no voice fallback if Sarvam fails" };
    return attempt(name, async () => {
      const r = await axios.get("https://api.elevenlabs.io/v1/user/subscription", {
        headers: { "xi-api-key": key },
        timeout: TIMEOUT_MS,
      });
      const left = Number(r.data?.character_limit ?? 0) - Number(r.data?.character_count ?? 0);
      const detail = `${left.toLocaleString("en-IN")} characters left (${r.data?.tier ?? "?"} plan)`;
      if (left <= 0) return { name, level: "error", detail: `${detail} — fallback voice is out of credit` };
      if (left < ELEVENLABS_WARN_CHARS) return { name, level: "warn", detail };
      return { name, level: "ok", detail };
    });
  }

  private async deepgram(): Promise<Check> {
    const name = "Deepgram (speech-to-text fallback)";
    const key = this.get("DEEPGRAM_API_KEY");
    if (!key) return { name, level: "warn", detail: "not set — no speech-to-text fallback if Sarvam fails" };
    return attempt(name, async () => {
      const headers = { Authorization: `Token ${key}` };
      const p = await axios.get("https://api.deepgram.com/v1/projects", { headers, timeout: TIMEOUT_MS });
      const id = p.data?.projects?.[0]?.project_id;
      try {
        const b = await axios.get(`https://api.deepgram.com/v1/projects/${id}/balances`, {
          headers,
          timeout: TIMEOUT_MS,
        });
        const amount = Number(b.data?.balances?.[0]?.amount ?? NaN);
        if (Number.isFinite(amount)) {
          const detail = `$${amount.toFixed(2)} balance`;
          return { name, level: amount <= 0 ? "error" : amount < 2 ? "warn" : "ok", detail };
        }
      } catch {
        // Member-scoped keys can't read balances; the key itself still works.
      }
      return { name, level: "ok", detail: "key works (balance needs an Owner/Admin key to show)" };
    });
  }

  private async exotel(): Promise<Check> {
    const name = "Exotel (phone calls)";
    const sid = this.get("EXOTEL_SID");
    if (!sid) return { name, level: "error", detail: "EXOTEL_SID not set — no calls" };
    return attempt(name, async () => {
      const r = await axios.get(
        `https://${this.get("EXOTEL_SUBDOMAIN") || "api.exotel.com"}/v1/Accounts/${sid}.json`,
        {
          auth: { username: this.get("EXOTEL_API_KEY"), password: this.get("EXOTEL_API_TOKEN") },
          timeout: TIMEOUT_MS,
        },
      );
      const status = String(r.data?.Account?.Status ?? "unknown");
      const detail = `account ${status} · ${r.data?.Account?.Type ?? ""} (balance: check the Exotel dashboard)`;
      return { name, level: status.toLowerCase() === "active" ? "ok" : "warn", detail };
    });
  }

  private async runtime() {
    let slots: { all: number; outbound: number } | null = null;
    try {
      slots = (await this.slots?.inUse()) ?? null;
    } catch {
      slots = null;
    }
    return {
      callsInProgress: slots,
      maxCalls: this.slots ? { all: this.slots.maxCalls, outbound: this.slots.maxOutbound } : null,
      llmBreakers: this.llm.breakerState(),
      recordedLines: this.clips.lineCount,
      uptimeMin: Math.round(process.uptime() / 60),
    };
  }
}

// A vendor call that throws becomes an "error" row carrying the vendor's own message
// (e.g. Sarvam "No credits available.", OpenRouter 401) — that text is what an
// operator needs to see, not a generic "failed".
async function attempt(name: string, fn: () => Promise<Check>): Promise<Check> {
  try {
    return await fn();
  } catch (err) {
    const res = axios.isAxiosError(err) ? err.response : undefined;
    const data = res?.data as Record<string, unknown> | undefined;
    const vendorMsg =
      (data?.error as { message?: string })?.message ??
      (typeof data?.error === "string" ? data.error : undefined) ??
      (data?.detail as { message?: string })?.message ??
      (data?.message as string | undefined) ??
      (data?.RestException as { Message?: string })?.Message;
    const why =
      res?.status === 401 || res?.status === 403
        ? "key rejected or no credit"
        : res?.status === 402
          ? "out of credit"
          : res?.status === 429
            ? "rate-limited"
            : res
              ? `HTTP ${res.status}`
              : err instanceof Error
                ? err.message
                : String(err);
    return { name, level: "error", detail: vendorMsg ? `${why}: ${vendorMsg}` : why };
  }
}
