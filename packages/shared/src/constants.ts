// ─── Service identifiers ─────────────────────────────────────────────────────
// Stable names shared across the API and worker processes — used for logging
// context, health reporting, and (from Step 6) BullMQ queue routing. Domain
// schemas and types are added to this package as each build step lands.

export const SERVICE = {
  API: "pikorua-voice-api",
  WORKER: "pikorua-voice-worker",
} as const;

export type ServiceName = (typeof SERVICE)[keyof typeof SERVICE];
