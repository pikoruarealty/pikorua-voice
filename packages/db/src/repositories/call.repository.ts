import { eq } from "drizzle-orm";
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
