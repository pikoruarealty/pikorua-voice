import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class GuardrailService {
  private readonly logger = new Logger("GuardrailService");

  // Simple keyword-based guardrails. Returns { triggered, rule, replacement }
  check(text: string) {
    const normalized = text.toLowerCase();

    const checks: Array<{ rule: string; pattern: RegExp; replacement: string }> = [
      { rule: "pricing_claim", pattern: /\b(price|cost|discount|fee|charge|₹|\$)\b/, replacement: "I'm sorry, I can't help with pricing or cost claims." },
      { rule: "roi_guarantee", pattern: /\b(roi|guarantee|return on investment|guaranteed returns)\b/, replacement: "I'm sorry, I can't provide guaranteed ROI claims." },
      { rule: "legal_advice", pattern: /\b(advice|legal|lawyer|attorney|court|sue)\b/, replacement: "I can't provide legal advice; please consult a qualified professional." },
      { rule: "tax_advice", pattern: /\b(tax|fema|irs|income tax|gst|vat)\b/, replacement: "I can't provide tax advice; please consult a tax professional." },
      { rule: "fabricated_inventory", pattern: /\b(in stock|available now|inventory|in-stock)\b/, replacement: "I can't confirm inventory or availability." },
      { rule: "fabricated_project", pattern: /\b(project details|implementation plan|architecture)\b/, replacement: "I can't fabricate project details or guarantees." },
    ];

    for (const c of checks) {
      if (c.pattern.test(normalized)) {
        this.logger.warn(`Guardrail triggered: ${c.rule}`);
        return { triggered: true, rule: c.rule, replacement: c.replacement };
      }
    }

    return { triggered: false, rule: null, replacement: null };
  }
}
