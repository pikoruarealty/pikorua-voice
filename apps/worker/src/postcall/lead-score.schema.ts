import { z } from "zod";

// Profession classification drives the hard-override rules (PRD scoring §):
//  • broker    → never a genuine buyer → score forced to 0
//  • builder   → developer, exploratory interest → 50-60 band
//  • friend    → enquiring on behalf of someone else → 50-60 band
//  • end_user  → prospective buyer for themselves → scored on the rubric
//  • unknown   → not stated → scored on the rubric
export const professionCategory = z.enum(["broker", "builder", "friend", "end_user", "unknown"]);
export type ProfessionCategory = z.infer<typeof professionCategory>;

// Why a lead is hesitating / didn't commit — captured on any call, and the whole
// point of the post-visit feedback call (#4). Categories are the recurring
// real-estate blockers; `other` catches the rest. Surfaced to the CRM so sales
// walks into the follow-up already knowing the objection.
export const objectionCategory = z.enum([
  "price",
  "possession_timeline",
  "location",
  "family_decision",
  "loan_finance",
  "comparison",
  "layout_size",
  "amenities",
  "other",
]);
export type ObjectionCategory = z.infer<typeof objectionCategory>;

export const ObjectionSchema = z.object({
  // A novel/unseen category from the model coerces to "other" rather than failing
  // the whole score parse (which would drop us to the heuristic fallback).
  category: objectionCategory.catch("other"),
  // The caller's own words (verbatim or lightly paraphrased); null if unclear.
  detail: z.string().nullable().catch(null).default(null),
});
export type Objection = z.infer<typeof ObjectionSchema>;

// Structured, per-criterion facts extracted from the transcript. Surfaced to the
// CRM (via crm-payload) so an agent can see WHY a lead scored the way it did —
// not just the number. Every field is null/false when the caller didn't disclose
// it, so the CRM can distinguish "not asked" from "answered".
// EVERY field below is .catch()-guarded on purpose. `.default()` only fills an
// ABSENT (undefined) key — a key the model explicitly sends as `null`, or with the
// wrong type, still throws and fails the WHOLE parse, which silently discards the
// entire LLM result and drops post-call scoring to the crude keyword heuristic.
// That is exactly what happened in production: `"siteVisit": {"intent": null}`
// binned an otherwise-perfect score. One malformed field must never cost us the
// other twelve.
export const LeadBreakdownSchema = z.object({
  professionCategory: professionCategory.catch("unknown").default("unknown"),
  // The caller's own name, as they said it. Maya asks for this in the call flow and
  // callers answer ("મેરા નામ નિખિલે"), but it used to survive only inside the raw
  // transcript — so every CRM lead card rendered as "Unknown". For outbound calls
  // the campaign target's fullName is the stronger source and wins (see crm-payload).
  name: z.string().nullable().catch(null).default(null),
  // Employer / business name ("Matangi traders"). Distinct from `profession`:
  // the CRM shows COMPANY and PROFESSION as separate fields.
  company: z.string().nullable().catch(null).default(null),
  // Free-text profession as stated ("doctor", "runs a textile business", …).
  profession: z.string().nullable().catch(null).default(null),
  // Budget only if a specific figure was given ("5 crore"); null for vague answers.
  budget: z.string().nullable().catch(null).default(null),
  // Requirement / configuration ("4 BHK", "5 BHK, ~5000 sqft").
  requirements: z.string().nullable().catch(null).default(null),
  // Preferred location / micro-market ("SBR", "Iskon-Ambli", "Thaltej").
  location: z.string().nullable().catch(null).default(null),
  // Where the caller currently lives.
  currentResidence: z.string().nullable().catch(null).default(null),
  siteVisit: z
    .object({
      // Did the caller agree to / ask for a visit? `.catch(false)` because the
      // model sends an explicit null here when the visit never came up.
      intent: z.boolean().catch(false).default(false),
      // Free-text timing as discussed ("this Sunday", "next week").
      when: z.string().nullable().catch(null).default(null),
      // Days from the call to the proposed visit; drives the visit points.
      gapDays: z.number().int().nullable().catch(null).default(null),
    })
    .catch({ intent: false, when: null, gapDays: null })
    .default({ intent: false, when: null, gapDays: null }),
  // Interest in seeing the sample house / model flat.
  sampleHouseInterest: z.boolean().nullable().catch(null).default(null),
  // Reasons the caller is hesitating / not proceeding. Empty when none surfaced.
  // .catch([]) so a malformed objections field never fails the whole score parse.
  objections: z.array(ObjectionSchema).catch([]).default([]),
});
export type LeadBreakdown = z.infer<typeof LeadBreakdownSchema>;

export const LeadScoreLlmSchema = z.object({
  // `score` stays STRICT deliberately: it is the one field with no safe fallback,
  // and a result without a usable score is better handled by the caller's
  // heuristic than by inventing a number here.
  score: z.number().int().min(0).max(100),
  // `.catch` value is irrelevant — clampResult() recomputes the label from the
  // final (override-adjusted) score and overwrites whatever the model said. This
  // guard exists purely so a junk label ("invalid", seen in production) cannot
  // throw away the score, rationale and breakdown alongside it.
  label: z.enum(["hot", "warm", "cold"]).catch("cold"),
  // nullish → the caller's `?? heuristic rationale` fallback fires, instead of us
  // fabricating a reason the model never gave.
  rationale: z.string().min(1).nullish().catch(null),
  timeline: z
    .enum(["immediate", "short_term", "long_term", "exploring", "unknown"])
    .catch("unknown"),
  matchedPos: z.array(z.string()).catch([]).default([]),
  matchedNeg: z.array(z.string()).catch([]).default([]),
  breakdown: LeadBreakdownSchema.catch(() => LeadBreakdownSchema.parse({})).default({}),
});

export type LeadScoreLlmResult = z.infer<typeof LeadScoreLlmSchema>;
