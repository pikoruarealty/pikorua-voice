import { desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { webhookEvents } from "../schema";
import type { NewWebhookEvent, WebhookEvent } from "../schema";

export class WebhookEventRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<WebhookEvent | undefined> {
    return this.db.query.webhookEvents.findFirst({ where: eq(webhookEvents.id, id) });
  }

  async findByProviderCallSid(sid: string): Promise<WebhookEvent[]> {
    return this.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerCallSid, sid))
      .orderBy(desc(webhookEvents.receivedAt));
  }

  async create(data: NewWebhookEvent): Promise<WebhookEvent> {
    const [row] = await this.db.insert(webhookEvents).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  async markProcessed(id: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(webhookEvents.id, id));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ status: "failed", error, processedAt: new Date() })
      .where(eq(webhookEvents.id, id));
  }
}
