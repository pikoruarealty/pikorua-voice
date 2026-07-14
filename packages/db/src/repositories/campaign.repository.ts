import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { campaigns } from "../schema";
import type { Campaign, NewCampaign } from "../schema";

type CampaignStatus = (typeof campaigns.status.enumValues)[number];

export class CampaignRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Campaign | undefined> {
    return this.db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  }

  // Look up a campaign by its `source` tag. Used to find-or-create the singleton
  // system campaigns that own reconfirm/feedback dials (source="system:reconfirm"
  // / "system:feedback"), so those calls carry the right scriptRef.
  async findBySource(source: string): Promise<Campaign | undefined> {
    return this.db.query.campaigns.findFirst({ where: eq(campaigns.source, source) });
  }

  async findAll(filter?: { status?: CampaignStatus }): Promise<Campaign[]> {
    return this.db.query.campaigns.findMany({
      where: filter?.status ? eq(campaigns.status, filter.status) : undefined,
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async create(data: NewCampaign): Promise<Campaign> {
    const [row] = await this.db.insert(campaigns).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  async update(id: string, data: Partial<NewCampaign>): Promise<Campaign | undefined> {
    const [row] = await this.db.update(campaigns).set(data).where(eq(campaigns.id, id)).returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(campaigns).where(eq(campaigns.id, id));
  }
}
