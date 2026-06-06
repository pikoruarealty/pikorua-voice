import { desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { callEvents } from "../schema";
import type { CallEvent, NewCallEvent } from "../schema";

export class CallEventRepository {
  constructor(private readonly db: Database) {}

  async findByCallId(callId: string): Promise<CallEvent[]> {
    return this.db
      .select()
      .from(callEvents)
      .where(eq(callEvents.callId, callId))
      .orderBy(desc(callEvents.createdAt));
  }

  async create(data: NewCallEvent): Promise<CallEvent> {
    const [row] = await this.db.insert(callEvents).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  async createMany(data: NewCallEvent[]): Promise<CallEvent[]> {
    if (data.length === 0) return [];
    return this.db.insert(callEvents).values(data).returning();
  }
}
