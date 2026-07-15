// Resolve a concrete visit datetime from what the LLM scorer extracted, for the
// auto (provisional) appointment path (#2). `gapDays` gives the DAY; `when` (the
// caller's own words, e.g. "tomorrow 3 PM (कल तीन बजे)") gives the TIME. Both are
// used — pinning every visit to a default hour would make the reconfirmation call
// announce a slot the caller never agreed to, which is worse than not calling.
// Returns null when no reliable date is available (the authoritative API path
// covers those). Pure — unit-tested.

// Re-exported so appointment code can import date helpers from one place.
export { formatIstWhen } from "@pikorua/shared";

// Fallback slot hour (IST) used only when `when` carries no usable time.
export const DEFAULT_VISIT_HOUR_IST = 11;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// Refuse absurd gaps — a mis-extracted 900-day "gap" must not book a visit.
const MAX_GAP_DAYS = 60;
// Site visits only happen inside office hours; anything outside is a mis-parse
// (e.g. "3" from "3 BHK") and falls back to the default slot.
const MIN_VISIT_HOUR = 8;
const MAX_VISIT_HOUR = 20;

/**
 * Pull the visit time out of the scorer's free-text `when`.
 * Handles "3 PM", "3pm", "5:30 PM", "11 AM", and the Hindi "3 बजे" / "3:30 बजे".
 * Returns null when no usable time is present.
 */
export function parseVisitTime(when: string | null | undefined): { hour: number; minute: number } | null {
  if (!when) return null;
  const text = String(when);

  // 1. Explicit AM/PM — unambiguous.
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(text);
  if (ampm) {
    let hour = parseInt(ampm[1], 10);
    const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const isPm = /^p/i.test(ampm[3]);
    if (hour === 12) hour = isPm ? 12 : 0;
    else if (isPm) hour += 12;
    return inRange(hour, minute) ? { hour, minute } : null;
  }

  // 2. Hindi "N बजे" — no AM/PM marker, so infer from the visit window. Office
  //    hours are ~11 AM–6 PM: 1–7 means afternoon/evening, 8–11 means morning.
  //    An explicit शाम/दोपहर (evening/afternoon) or सुबह (morning) wins over that.
  const baje = /\b(\d{1,2})(?::(\d{2}))?\s*बजे/.exec(text);
  if (baje) {
    let hour = parseInt(baje[1], 10);
    const minute = baje[2] ? parseInt(baje[2], 10) : 0;
    const saysEvening = /शाम|दोपहर|evening|afternoon/i.test(text);
    const saysMorning = /सुबह|morning/i.test(text);
    if (hour >= 1 && hour <= 7) {
      // "3 बजे" on a site-visit call means 3 PM unless they explicitly said सुबह.
      if (!saysMorning) hour += 12;
    } else if (hour === 12) {
      hour = saysMorning ? 0 : 12;
    } else if (saysEvening && hour < 12) {
      hour += 12;
    }
    return inRange(hour, minute) ? { hour, minute } : null;
  }

  return null;
}

function inRange(hour: number, minute: number): boolean {
  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    hour >= MIN_VISIT_HOUR &&
    hour <= MAX_VISIT_HOUR &&
    minute >= 0 &&
    minute <= 59
  );
}

export function resolveVisitDate(
  now: Date,
  gapDays: number | null | undefined,
  when?: string | null,
): Date | null {
  if (gapDays == null || !Number.isFinite(gapDays) || gapDays < 0 || gapDays > MAX_GAP_DAYS) {
    return null;
  }
  // Use the time the caller actually agreed to; fall back to the default slot only
  // when `when` carries none.
  const time = parseVisitTime(when) ?? { hour: DEFAULT_VISIT_HOUR_IST, minute: 0 };

  // Shift into IST so getUTC* fields read as the IST calendar date, add the gap,
  // then pin to the agreed time and convert back to a real (UTC) instant.
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate() + Math.round(gapDays);
  const istMidnightUtcMs = Date.UTC(y, m, d, 0, 0, 0) - IST_OFFSET_MS;
  const scheduled = new Date(
    istMidnightUtcMs + time.hour * 60 * 60 * 1000 + time.minute * 60 * 1000,
  );
  // Never schedule a visit in the past (e.g. gapDays=0 agreed for a slot that has
  // already gone by).
  if (scheduled.getTime() <= now.getTime()) return null;
  return scheduled;
}
