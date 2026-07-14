import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../client";
import { campaigns, campaignTargets } from "../schema";
import type { CampaignTarget, NewCampaignTarget } from "../schema";

type DialStatus = (typeof campaignTargets.dialStatus.enumValues)[number];

export class CampaignTargetRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<CampaignTarget | undefined> {
    return this.db.query.campaignTargets.findFirst({ where: eq(campaignTargets.id, id) });
  }

  async findByCampaignId(campaignId: string): Promise<CampaignTarget[]> {
    return this.db.query.campaignTargets.findMany({
      where: eq(campaignTargets.campaignId, campaignId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
  }

  async findPendingDials(limit: number): Promise<CampaignTarget[]> {
    return this.findRepairableDials(limit);
  }

  async findRepairableDials(limit: number): Promise<CampaignTarget[]> {
    const now = new Date();
    return this.db
      .select({ target: campaignTargets })
      .from(campaignTargets)
      .innerJoin(campaigns, eq(campaignTargets.campaignId, campaigns.id))
      .where(
        and(
          eq(campaigns.status, "active"),
          or(eq(campaignTargets.dialStatus, "pending"), eq(campaignTargets.dialStatus, "queued")),
          or(isNull(campaignTargets.nextAttemptAt), lte(campaignTargets.nextAttemptAt, now)),
        ),
      )
      .orderBy(campaignTargets.nextAttemptAt)
      .limit(limit)
      .then((rows) => rows.map((row) => row.target));
  }

  async create(data: NewCampaignTarget): Promise<CampaignTarget> {
    const [row] = await this.db.insert(campaignTargets).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  // True if this phone has ever been marked do_not_call on any target. Used to
  // honor an existing opt-out before placing a reminder/feedback dial (#2/#4).
  async isPhoneDoNotCall(phone: string): Promise<boolean> {
    const row = await this.db.query.campaignTargets.findFirst({
      where: and(eq(campaignTargets.phone, phone), eq(campaignTargets.dialStatus, "do_not_call")),
    });
    return row != null;
  }

  async createMany(data: NewCampaignTarget[]): Promise<CampaignTarget[]> {
    if (data.length === 0) return [];
    return this.db.insert(campaignTargets).values(data).onConflictDoNothing().returning();
  }

  async updateDialStatus(
    id: string,
    status: DialStatus,
    patch?: Partial<NewCampaignTarget>,
  ): Promise<CampaignTarget | undefined> {
    const [row] = await this.db
      .update(campaignTargets)
      .set({ dialStatus: status, ...patch })
      .where(eq(campaignTargets.id, id))
      .returning();
    return row;
  }

  async incrementAttempts(id: string, nextAttemptAt?: Date): Promise<CampaignTarget | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const attempts = (current.attempts ?? 0) + 1;
    const exhausted = attempts >= (current.maxAttempts ?? 3);
    const [row] = await this.db
      .update(campaignTargets)
      .set({
        attempts,
        lastAttemptAt: new Date(),
        nextAttemptAt: nextAttemptAt ?? null,
        dialStatus: exhausted ? "exhausted" : current.dialStatus,
      })
      .where(eq(campaignTargets.id, id))
      .returning();
    return row;
  }
}
