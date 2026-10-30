// ─── Call-slot gate ──────────────────────────────────────────────────────────
// Caps how many calls run at once across the API (inbound + live calls) and the
// worker (outbound dials). Without it a campaign fires dials back to back and a
// small VM ends up running dozens of calls at once, freezing all of them.
//
// Two Redis sorted sets, member = callId (or "dial:<targetId>" while a dial is
// being placed), score = last heartbeat in ms. Every operation is one Lua script,
// so the API and worker processes can't both take the last free slot.
//
// Slots of crashed processes or lost status callbacks have no heartbeat and are
// reaped after CALL_SLOT_STALE_MS, so a slot can never leak forever.

export type SlotKind = "inbound" | "outbound";

// Structural so this package doesn't depend on ioredis; an ioredis client fits.
export type SlotRedis = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export const CALL_SLOTS_KEY = "voice:call_slots";
export const CALL_SLOTS_OUTBOUND_KEY = "voice:call_slots:outbound";
export const CALL_SLOT_STALE_MS = 90_000;
export const CALL_SLOT_HEARTBEAT_MS = 30_000;

// KEYS: all, outbound. ARGV: member, kind, now, staleMs, max, maxOutbound, force.
// A member that already holds a slot (or a forced acquire) just refreshes its
// heartbeat — that is what heartbeats and an answered outbound call use.
const ACQUIRE = `
local now = tonumber(ARGV[3])
local cutoff = now - tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
local held = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not held and ARGV[7] ~= '1' then
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end
  if ARGV[2] == 'outbound' and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[6]) then return 0 end
end
redis.call('ZADD', KEYS[1], now, ARGV[1])
if ARGV[2] == 'outbound' then redis.call('ZADD', KEYS[2], now, ARGV[1]) end
return 1
`;

const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

// ARGV: from, to, now. Moves a slot to a new member without ever freeing it.
const RENAME = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2]) end
if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 then redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2]) end
return 1
`;

export class CallSlots {
  constructor(
    private readonly redis: SlotRedis,
    readonly maxCalls: number,
    readonly maxOutbound: number,
  ) {}

  async acquire(
    member: string,
    kind: SlotKind,
    opts: { force?: boolean; now?: number } = {},
  ): Promise<boolean> {
    const res = await this.redis.eval(
      ACQUIRE,
      2,
      CALL_SLOTS_KEY,
      CALL_SLOTS_OUTBOUND_KEY,
      member,
      kind,
      opts.now ?? Date.now(),
      CALL_SLOT_STALE_MS,
      this.maxCalls,
      this.maxOutbound,
      opts.force ? "1" : "0",
    );
    return Number(res) === 1;
  }

  async release(member: string): Promise<void> {
    await this.redis.eval(RELEASE, 2, CALL_SLOTS_KEY, CALL_SLOTS_OUTBOUND_KEY, member);
  }

  async rename(from: string, to: string, now = Date.now()): Promise<void> {
    await this.redis.eval(RENAME, 2, CALL_SLOTS_KEY, CALL_SLOTS_OUTBOUND_KEY, from, to, now);
  }
}
