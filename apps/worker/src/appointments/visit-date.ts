// Resolve a concrete visit datetime from what the LLM scorer extracted, for the
// auto (provisional) appointment path (#2). `gapDays` — days from the call to the
// visit — is the reliable signal; we pin the visit to a default IST slot on that
// day. Returns null when no reliable date is available (the authoritative API
// path covers those). Pure — unit-tested.

// Re-exported so appointment code can import date helpers from one place.
export { formatIstWhen } from "@pikorua/shared";

// Default slot hour (IST) used when only a day, not a time, is known.
export const DEFAULT_VISIT_HOUR_IST = 11;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// Refuse absurd gaps — a mis-extracted 900-day "gap" must not book a visit.
const MAX_GAP_DAYS = 60;

export function resolveVisitDate(
  now: Date,
  gapDays: number | null | undefined,
): Date | null {
  if (gapDays == null || !Number.isFinite(gapDays) || gapDays < 0 || gapDays > MAX_GAP_DAYS) {
    return null;
  }
  // Shift into IST so getUTC* fields read as the IST calendar date, add the gap,
  // then pin to the default slot hour and convert back to a real (UTC) instant.
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate() + Math.round(gapDays);
  const istMidnightUtcMs = Date.UTC(y, m, d, 0, 0, 0) - IST_OFFSET_MS;
  const scheduled = new Date(istMidnightUtcMs + DEFAULT_VISIT_HOUR_IST * 60 * 60 * 1000);
  // Never schedule a visit in the past (e.g. gapDays=0 called after the slot).
  if (scheduled.getTime() <= now.getTime()) return null;
  return scheduled;
}
