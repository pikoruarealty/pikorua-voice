// Shared date helpers so the API and worker render times identically.

// Human-readable IST rendering of an instant, e.g. "Sunday, 20 July at 11:00 AM".
// Used for reconfirmation greetings, appointment metadata, and CRM display.
export function formatIstWhen(date: Date): string {
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
