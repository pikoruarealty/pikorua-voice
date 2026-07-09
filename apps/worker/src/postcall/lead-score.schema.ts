import { z } from "zod";

// Profession classification drives the hard-override rules (PRD scoring §):
//  • broker    → never a genuine buyer → score forced to 0
//  • builder   → developer, exploratory interest → 50-60 band
//  • friend    → enquiring on behalf of someone else → 50-60 band
//  • end_user  → prospective buyer for themselves → scored on the rubric
//  • unknown   → not stated → scored on the rubric
export const professionCategory = z.enum(["broker", "builder", "friend", "end_user", "unknown"]);
export type ProfessionCategory = z.infer<typeof professionCategory>;

// Structured, per-criterion facts extracted from the transcript. Surfaced to the
// CRM (via crm-payload) so an agent can see WHY a lead scored the way it did —
// not just the number. Every field is null/false when the caller didn't disclose
// it, so the CRM can distinguish "not asked" from "answered".
export const LeadBreakdownSchema = z.object({
  professionCategory: professionCategory.default("unknown"),
  // Free-text profession as stated ("doctor", "runs a textile business", …).
  profession: z.string().nullable().default(null),
  // Budget only if a specific figure was given ("5 crore"); null for vague answers.
  budget: z.string().nullable().default(null),
  // Requirement / configuration ("4 BHK", "5 BHK, ~5000 sqft").
  requirements: z.string().nullable().default(null),
  // Preferred location / micro-market ("SBR", "Iskon-Ambli", "Thaltej").
  location: z.string().nullable().default(null),
  // Where the caller currently lives.
  currentResidence: z.string().nullable().default(null),
  siteVisit: z
    .object({
      // Did the caller agree to / ask for a visit?
      intent: z.boolean().default(false),
      // Free-text timing as discussed ("this Sunday", "next week").
      when: z.string().nullable().default(null),
      // Days from the call to the proposed visit; drives the visit points.
      gapDays: z.number().int().nullable().default(null),
    })
    .default({ intent: false, when: null, gapDays: null }),
  // Interest in seeing the sample house / model flat.
  sampleHouseInterest: z.boolean().nullable().default(null),
});
export type LeadBreakdown = z.infer<typeof LeadBreakdownSchema>;

export const LeadScoreLlmSchema = z.object({
  score: z.number().int().min(0).max(100),
  label: z.enum(["hot", "warm", "cold"]),
  rationale: z.string().min(1),
  timeline: z.enum(["immediate", "short_term", "long_term", "exploring", "unknown"]),
  matchedPos: z.array(z.string()).default([]),
  matchedNeg: z.array(z.string()).default([]),
  breakdown: LeadBreakdownSchema.default({}),
});

export type LeadScoreLlmResult = z.infer<typeof LeadScoreLlmSchema>;
