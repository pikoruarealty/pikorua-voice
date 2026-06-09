import type { Campaign } from "@pikorua/db";

// Campaign dial windows are specified in IST (Asia/Kolkata, UTC+05:30).
// All servers run in UTC, so we must offset before comparing HH:MM.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

function nowInIst(now: Date): number {
  // Convert UTC epoch to IST minutes-of-day.
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMinutes + IST_OFFSET_MINUTES) % (24 * 60);
}

export function nextDialWindowAt(campaign: Campaign, now: Date): Date | null {
  if (!campaign.dialWindowStart || !campaign.dialWindowEnd) {
    return null;
  }

  const startMinutes = parseClock(campaign.dialWindowStart);
  const endMinutes = parseClock(campaign.dialWindowEnd);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  const currentMinutes = nowInIst(now);
  const inWindow =
    startMinutes <= endMinutes
      ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
      : currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  if (inWindow) {
    return null;
  }

  // Build the next window-open timestamp in UTC.
  // Start from midnight IST of the current UTC day, add the appropriate offset.
  const istMidnightUtcMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    IST_OFFSET_MINUTES * 60_000;

  const targetDayOffset = currentMinutes < startMinutes ? 0 : 1;
  const nextMs =
    istMidnightUtcMs +
    targetDayOffset * 24 * 60 * 60_000 +
    startMinutes * 60_000;

  const next = new Date(nextMs);
  next.setUTCSeconds(0, 0);
  return next;
}

function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
