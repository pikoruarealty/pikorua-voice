import { and, eq, lt, or } from "drizzle-orm";
import type { Database } from "../client";
import { crmSyncLog } from "../schema";
import type { CrmSyncLogEntry, NewCrmSyncLogEntry } from "../schema";

type SyncStatus = (typeof crmSyncLog.status.enumValues)[number];

export class CrmSyncLogRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<CrmSyncLogEntry | undefined> {
    return this.db.query.crmSyncLog.findFirst({ where: eq(crmSyncLog.id, id) });
  }

  async findByCallId(callId: string): Promise<CrmSyncLogEntry[]> {
    return this.db.query.crmSyncLog.findMany({
      where: eq(crmSyncLog.callId, callId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<CrmSyncLogEntry | undefined> {
    return this.db.query.crmSyncLog.findFirst({
      where: eq(crmSyncLog.idempotencyKey, idempotencyKey),
    });
  }

  async findPending(limit: number): Promise<CrmSyncLogEntry[]> {
    return this.db.query.crmSyncLog.findMany({
      where: eq(crmSyncLog.status, "pending"),
      limit,
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
  }

  async findRetryable(limit: number, maxAttempts: number): Promise<CrmSyncLogEntry[]> {
    return this.db.query.crmSyncLog.findMany({
      where: and(
        or(eq(crmSyncLog.status, "pending"), eq(crmSyncLog.status, "failed")),
        lt(crmSyncLog.attempts, maxAttempts),
      ),
      limit,
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
  }

  async create(data: NewCrmSyncLogEntry): Promise<CrmSyncLogEntry> {
    const [row] = await this.db.insert(crmSyncLog).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  async createOrGetByIdempotencyKey(data: NewCrmSyncLogEntry): Promise<CrmSyncLogEntry> {
    if (!data.idempotencyKey) {
      return this.create(data);
    }

    const existing = await this.findByIdempotencyKey(data.idempotencyKey);
    if (existing) {
      return existing;
    }

    const [row] = await this.db
      .insert(crmSyncLog)
      .values(data)
      .onConflictDoNothing({ target: crmSyncLog.idempotencyKey })
      .returning();
    return row ?? (await this.findByIdempotencyKey(data.idempotencyKey))!;
  }

  async updateStatus(
    id: string,
    status: SyncStatus,
    patch?: Partial<NewCrmSyncLogEntry>,
  ): Promise<CrmSyncLogEntry | undefined> {
    const [row] = await this.db
      .update(crmSyncLog)
      .set({ status, ...patch })
      .where(eq(crmSyncLog.id, id))
      .returning();
    return row;
  }
}
