import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

export type GuardrailResult = {
  triggered: boolean;
  rule: string | null;
  replacement: string | null;
};

// Hard keyword patterns that must ALWAYS be caught regardless of LLM availability.
// The semantic LLM check runs in addition and can catch paraphrases.
const HARD_RULES: Array<{ rule: string; pattern: RegExp; replacement: string }> = [
  {
    rule: "pricing_claim",
    pattern: /\b(exact price|costs ₹|costs \$|quote you|give you a price)\b/i,
    replacement:
      "I'm not able to share specific pricing right now — our consultant will walk you through that in detail.",
  },
  {
    rule: "roi_guarantee",
    pattern: /\b(guaranteed return|guaranteed roi|promise.*return|will definitely appreciate)\b/i,
    replacement:
      "I can't promise specific returns — real estate values depend on many factors. Our consultant can share market data.",
  },
  {
    rule: "legal_advice",
    pattern:
      /\b(you should consult a lawyer|legally speaking|from a legal standpoint|your legal right)\b/i,
    replacement:
      "For legal questions, please consult a qualified legal professional. I can connect you with our consultant instead.",
  },
  {
    rule: "tax_advice",
    pattern:
      /\b(you can save tax|tax benefit of|under section 80|claim a deduction|FEMA compliance)\b/i,
    replacement:
      "Tax matters are best handled by a tax advisor. Our team can introduce you to a qualified professional.",
  },
  {
    rule: "fabricated_inventory",
    pattern: /\b(only \d+ unit[s]? left|last remaining|almost sold out|inventory is limited)\b/i,
    replacement:
      "I don't have real-time availability details — our consultant can check the current status for you.",
  },
];

// Prompt sent to the LLM for semantic guardrail evaluation.
// Returns JSON { violated: boolean, rule: string | null, safeSummary: string | null }
function buildGuardrailPrompt(text: string): string {
  return [
    "You are a compliance checker for a real estate AI concierge. Evaluate the REPLY below.",
    "Check for ANY of these violations:",
    "1. pricing_claim — quoting specific prices, discounts, or costs",
    "2. roi_guarantee — promising returns, appreciation, or financial gains",
    "3. legal_advice — providing legal opinions or advice",
    "4. tax_advice — advising on tax savings, deductions, or compliance",
    "5. fabricated_inventory — claiming limited stock or urgency without data",
    "6. fabricated_project — inventing project details, timelines, or specifications",
    "",
    'Reply ONLY with valid JSON (no markdown): { "violated": boolean, "rule": string | null, "safeSummary": string | null }',
    "If violated, set rule to the matching rule name and safeSummary to a safe rephrasing.",
    "If not violated, set violated=false, rule=null, safeSummary=null.",
    "",
    `REPLY TO CHECK:\n${text}`,
  ].join("\n");
}

@Injectable()
export class GuardrailService {
  private readonly logger = new Logger("GuardrailService");

  constructor(private readonly config: ConfigService) {}

  // Synchronous hard-rule check — always fast, always runs.
  checkHard(text: string): GuardrailResult {
    const normalized = text.toLowerCase();
    for (const c of HARD_RULES) {
      if (c.pattern.test(normalized)) {
        this.logger.warn(`Hard guardrail triggered: ${c.rule}`);
        return { triggered: true, rule: c.rule, replacement: c.replacement };
      }
    }
    return { triggered: false, rule: null, replacement: null };
  }

  // Semantic guardrail via LLM — catches paraphrases and indirect violations.
  // Falls back gracefully to the hard check result if the LLM is unavailable.
  async checkSemantic(text: string): Promise<GuardrailResult> {
    const prompt = buildGuardrailPrompt(text);

    // Always use Haiku for guardrail classification regardless of the conversation model
    // configured in ANTHROPIC_MODEL — it's fast, cheap, and accurate enough for binary checks.
    const anthropicKey = this.config.get<string>("ANTHROPIC_API_KEY");
    const anthropicModel = "claude-haiku-4-5-20251001";
    if (anthropicKey) {
      try {
        const res = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: anthropicModel,
            max_tokens: 150,
            messages: [{ role: "user", content: prompt }],
          },
          {
            headers: {
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            timeout: 4000,
          },
        );
        const raw = String(res.data?.content?.[0]?.text ?? "").trim();
        return this.parseSemanticResult(raw, text);
      } catch (err) {
        this.logger.warn(
          "Semantic guardrail (Anthropic) failed — skipping LLM check",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Fallback: Google Gemini
    const googleKey = this.config.get<string>("GOOGLE_GENERATIVE_AI_API_KEY");
    const googleModel = String(this.config.get("GOOGLE_MODEL") ?? "gemini-2.0-flash");
    if (googleKey) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent`,
          { contents: [{ role: "user", parts: [{ text: prompt }] }] },
          { params: { key: googleKey }, timeout: 4000 },
        );
        const raw = String(res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
        return this.parseSemanticResult(raw, text);
      } catch (err) {
        this.logger.warn(
          "Semantic guardrail (Google) failed — skipping LLM check",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // No LLM available — hard rules only (already applied by caller)
    return { triggered: false, rule: null, replacement: null };
  }

  // Convenience: run hard check first, then semantic check if hard passes.
  // Returns the first triggered result or a clean pass.
  async check(text: string): Promise<GuardrailResult> {
    const hard = this.checkHard(text);
    if (hard.triggered) return hard;

    const semantic = await this.checkSemantic(text);
    if (semantic.triggered) {
      this.logger.warn(`Semantic guardrail triggered: ${semantic.rule}`);
      return semantic;
    }

    return { triggered: false, rule: null, replacement: null };
  }

  private parseSemanticResult(raw: string, originalText: string): GuardrailResult {
    // Strip markdown code fences if the LLM wrapped the JSON
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
      const parsed = JSON.parse(jsonStr) as {
        violated?: boolean;
        rule?: string | null;
        safeSummary?: string | null;
      };
      if (parsed.violated && parsed.rule) {
        return {
          triggered: true,
          rule: parsed.rule,
          replacement:
            parsed.safeSummary ??
            "I'm not able to provide that information. Our consultant will be happy to help.",
        };
      }
      return { triggered: false, rule: null, replacement: null };
    } catch {
      this.logger.warn(`Semantic guardrail JSON parse failed; raw="${raw.slice(0, 100)}"`);
      return { triggered: false, rule: null, replacement: null };
    }
  }
}
