import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";
import type { Database } from "@pikorua/db";

// Cost per call and per service, for the /costs page.
//
// What is MEASURED vs ESTIMATED:
//   LLM   measured  — OpenRouter's billed USD per turn (call_turns.llm_cost_usd).
//   TTS   estimated — characters sent to TTS × the Sarvam rate. Recorded lines
//                     (greetings, goodbyes, fillers) cost ₹0 but still count their
//                     characters here when they are a persisted turn, so this is a
//                     slight over-estimate. A turn spoken by the ElevenLabs
//                     fallback is priced at the Sarvam rate too (turns don't record
//                     which voice spoke).
//   STT   estimated — call duration × the per-hour rate (all of the call is
//                     streamed to the speech-to-text).
//   Phone estimated — call duration × the Exotel per-minute rate.
// Not included: post-call lead-scoring LLM calls (the worker doesn't record them).
// Rates are settings (see config/env.ts) — they are list prices, check your plan.

export type Rates = {
  usdInr: number;
  ttsInrPer10kChars: number;
  sttInrPerHour: number;
  exotelInrPerMin: number;
};

export type CallCostRow = {
  id: string;
  at: string;
  direction: string;
  locale: string | null;
  isDemo: boolean;
  durationSec: number;
  turns: number;
  llmUsd: number;
  ttsChars: number;
};

export type CallCost = {
  id: string;
  at: string;
  direction: string;
  locale: string | null;
  isDemo: boolean;
  durationSec: number;
  turns: number;
  llm: number;
  tts: number;
  stt: number;
  phone: number;
  total: number;
};

export function priceCall(r: CallCostRow, rates: Rates): CallCost {
  const llm = r.llmUsd * rates.usdInr;
  const tts = (r.ttsChars / 10_000) * rates.ttsInrPer10kChars;
  const stt = (r.durationSec / 3600) * rates.sttInrPerHour;
  const phone = (r.durationSec / 60) * rates.exotelInrPerMin;
  return { ...r, llm, tts, stt, phone, total: llm + tts + stt + phone };
}

export function summarize(rows: CallCostRow[], rates: Rates) {
  const calls = rows.map((r) => priceCall(r, rates));
  const sum = (xs: CallCost[], k: "llm" | "tts" | "stt" | "phone" | "total") =>
    xs.reduce((a, c) => a + c[k], 0);
  // Averages are over real phone calls that were answered; browser-demo calls
  // still count toward the totals (they cost real money) but not the average.
  const answered = calls.filter((c) => !c.isDemo && (c.turns > 0 || c.durationSec > 0));
  const avg = (k: "llm" | "tts" | "stt" | "phone" | "total") =>
    answered.length ? sum(answered, k) / answered.length : 0;
  return {
    totals: {
      calls: calls.length,
      answeredCalls: answered.length,
      demoCalls: calls.filter((c) => c.isDemo).length,
      llm: sum(calls, "llm"),
      tts: sum(calls, "tts"),
      stt: sum(calls, "stt"),
      phone: sum(calls, "phone"),
      total: sum(calls, "total"),
    },
    perCall: {
      llm: avg("llm"),
      tts: avg("tts"),
      stt: avg("stt"),
      phone: avg("phone"),
      total: avg("total"),
      avgDurationSec: answered.length
        ? answered.reduce((a, c) => a + c.durationSec, 0) / answered.length
        : 0,
    },
    calls,
  };
}

type RawRow = {
  id: string;
  created_at: Date | string;
  direction: string;
  locale: string | null;
  provider_call_sid: string | null;
  duration_seconds: number | null;
  turns: string | number;
  llm_usd: string | number;
  tts_chars: string | number;
};

@Injectable()
export class CostService {
  constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  rates(): Rates {
    const n = (key: string, fallback: number) => {
      const v = Number(this.config.get(key));
      return Number.isFinite(v) && v >= 0 ? v : fallback;
    };
    return {
      usdInr: n("USD_INR", 85),
      ttsInrPer10kChars: n("SARVAM_TTS_INR_PER_10K_CHARS", 30),
      sttInrPerHour: n("STT_INR_PER_HOUR", 30),
      exotelInrPerMin: n("EXOTEL_INR_PER_MIN", 0),
    };
  }

  async report(days: number) {
    const d = Math.min(365, Math.max(1, Math.floor(days) || 30));
    const result = (await this.db.execute(sql`
      SELECT c.id, c.created_at, c.direction, c.locale, c.provider_call_sid,
             c.duration_seconds,
             COUNT(t.id) FILTER (WHERE t.role = 'assistant')   AS turns,
             COALESCE(SUM(t.llm_cost_usd), 0)                  AS llm_usd,
             COALESCE(SUM(t.tts_chars), 0)                     AS tts_chars
        FROM calls c
        LEFT JOIN call_turns t ON t.call_id = c.id
       WHERE c.created_at >= now() - make_interval(days => ${d})
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT 3000
    `)) as unknown as RawRow[];

    const rows: CallCostRow[] = [...result].map((r) => ({
      id: r.id,
      at: new Date(r.created_at).toISOString(),
      direction: r.direction,
      locale: r.locale,
      isDemo: String(r.provider_call_sid ?? "").startsWith("demo-"),
      durationSec: Number(r.duration_seconds ?? 0),
      turns: Number(r.turns),
      llmUsd: Number(r.llm_usd),
      ttsChars: Number(r.tts_chars),
    }));
    const rates = this.rates();
    const s = summarize(rows, rates);
    return {
      days: d,
      generatedAt: new Date().toISOString(),
      rates,
      ratesMissing: rates.exotelInrPerMin === 0 ? ["EXOTEL_INR_PER_MIN"] : [],
      totals: s.totals,
      perCall: s.perCall,
      calls: s.calls.slice(0, 200),
    };
  }
}
