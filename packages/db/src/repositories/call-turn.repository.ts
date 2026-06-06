import { asc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { callTurns } from "../schema";
import type { CallTurn, NewCallTurn } from "../schema";

export class CallTurnRepository {
  constructor(private readonly db: Database) {}

  async findByCallId(callId: string): Promise<CallTurn[]> {
    return this.db
      .select()
      .from(callTurns)
      .where(eq(callTurns.callId, callId))
      .orderBy(asc(callTurns.turnIndex));
  }

  async create(data: NewCallTurn): Promise<CallTurn> {
    const [row] = await this.db.insert(callTurns).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  async createMany(data: NewCallTurn[]): Promise<CallTurn[]> {
    if (data.length === 0) return [];
    return this.db.insert(callTurns).values(data).returning();
  }

  async countByCallId(callId: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(callTurns)
      .where(eq(callTurns.callId, callId));
    return rows.length;
  }
}
