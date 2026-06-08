import type { Campaign } from "@pikorua/db";

export function nextDialWindowAt(campaign: Campaign, now: Date): Date | null {
  if (!campaign.dialWindowStart || !campaign.dialWindowEnd) {
    return null;
  }

  const startMinutes = parseClock(campaign.dialWindowStart);
  const endMinutes = parseClock(campaign.dialWindowEnd);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const inWindow =
    startMinutes <= endMinutes
      ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
      : currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  if (inWindow) {
    return null;
  }

  const next = new Date(now);
  next.setSeconds(0, 0);
  const targetDayOffset = currentMinutes < startMinutes ? 0 : 1;
  next.setDate(next.getDate() + targetDayOffset);
  next.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  return next;
}

function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
