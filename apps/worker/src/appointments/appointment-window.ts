// Pure scheduling math for site-visit reminder (#2) and feedback (#4) calls.
// No I/O, so it is unit-tested directly without a DB or clock.

export const T24_WINDOW_MS = 24 * 60 * 60 * 1000;
export const T2_WINDOW_MS = 2 * 60 * 60 * 1000;
// Never place a reminder call within this lead time of the visit (or after it) —
// a call two minutes before the visit is pointless and annoying.
export const MIN_REMINDER_LEAD_MS = 15 * 60 * 1000;

export type ReminderKind = "t24" | "t2" | null;

function toMs(v: Date | number): number {
  return v instanceof Date ? v.getTime() : v;
}

// Which reminder (if any) is due for an appointment right now.
//   • t24 fires once, between 24h and 2h before the visit
//   • t2  fires once, between 2h and 15min before the visit
// The two windows are mutually exclusive. `sentT24`/`sentT2` say whether that
// reminder already fired, so each window fires at most once. An appointment
// created inside a window still gets that single reminder (e.g. one booked 90min
// out gets only the t2 reminder).
export function dueReminder(
  scheduledAt: Date | number,
  now: Date | number,
  sentT24: boolean,
  sentT2: boolean,
): ReminderKind {
  const dt = toMs(scheduledAt) - toMs(now);
  if (dt <= MIN_REMINDER_LEAD_MS) return null; // too close / already passed
  if (dt <= T2_WINDOW_MS) return sentT2 ? null : "t2";
  if (dt <= T24_WINDOW_MS) return sentT24 ? null : "t24";
  return null; // more than 24h out — not yet
}

// The post-visit feedback call fires once, `delayMs` after the visit time.
export function dueFeedback(
  scheduledAt: Date | number,
  now: Date | number,
  delayMs: number,
  sentFeedback: boolean,
): boolean {
  if (sentFeedback) return false;
  return toMs(now) - toMs(scheduledAt) >= delayMs;
}
