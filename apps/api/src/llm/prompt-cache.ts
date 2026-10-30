// Splits a system prompt into a part shared by every call (cached once, reused
// across calls) and a short per-call tail (lead name, campaign, briefing).
//
// The marker never reaches the model: LlmService turns the two halves into two
// system content parts, each with its own cache breakpoint, and for models without
// prompt caching joins them with a blank line.
export const PROMPT_CACHE_SPLIT = "\n\n<<<PROMPT_CACHE_SPLIT>>>\n\n";

export function splitPromptForCache(systemPrompt: string): string[] {
  return systemPrompt.split(PROMPT_CACHE_SPLIT).filter((part) => part.length > 0);
}
