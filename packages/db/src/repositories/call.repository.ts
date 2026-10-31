import { and, count, eq, ne } from "drizzle-orm";
import type { Database } from "../client";
import { calls } from "../schema";
import type { Call, NewCall } from "../schema";

export class CallRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Call | undefined> {
    return this.db.query.calls.findFirst({ where: eq(calls.id, id) });
  }

  async findByProviderCallSid(sid: string): Promise<Call | undefined> {
    return this.db.query.calls.findFirst({ where: eq(calls.providerCallSid, sid) });
  }

  // Most recent outbound call that has been dialed (status "initiated") but whose
  // voicebot stream has not been adopted yet, created within `withinMs`.
  //
  // WHY: Exotel's voicebot stream `call_sid` frequently differs from the Sid the
  // /Calls/connect.json response returned (which the worker stored as
  // providerCallSid), so findByProviderCallSid misses on outbound calls and the
  // gateway would fall back to CALL_LOCALE_DEFAULT — silently losing the target's
  // locale (e.g. a gu-IN call becomes Hindi). The gateway uses this to recover the
  // dialed call and relink it to the real stream call_sid. Adoption flips status to
  // "in_progress", so an already-adopted call is never returned again.
  async findRecentOutboundAwaitingStream(withinMs = 180_000): Promise<Call | undefined> {
    const cutoff = new Date(Date.now() - withinMs);
    return this.db.query.calls.findFirst({
      where: (t, { and, eq: eqOp, gt }) =>
        and(eqOp(t.direction, "outbound"), eqOp(t.status, "initiated"), gt(t.createdAt, cutoff)),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  // Inbound calls from this number, not counting `excludeCallId` (the live one).
  async countInboundFrom(fromNumber: string, excludeCallId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(calls)
      .where(
        and(
          eq(calls.direction, "inbound"),
          eq(calls.fromNumber, fromNumber),
          ne(calls.id, excludeCallId),
        ),
      );
    return row?.n ?? 0;
  }

  async findByCampaignId(campaignId: string): Promise<Call[]> {
    return this.db.query.calls.findMany({
      where: eq(calls.campaignId, campaignId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async create(data: NewCall): Promise<Call> {
    const [row] = await this.db.insert(calls).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  async update(id: string, data: Partial<NewCall>): Promise<Call | undefined> {
    const [row] = await this.db.update(calls).set(data).where(eq(calls.id, id)).returning();
    return row;
  }

  async updateByProviderCallSid(sid: string, data: Partial<NewCall>): Promise<Call | undefined> {
    const [row] = await this.db
      .update(calls)
      .set(data)
      .where(eq(calls.providerCallSid, sid))
      .returning();
    return row;
  }
}
