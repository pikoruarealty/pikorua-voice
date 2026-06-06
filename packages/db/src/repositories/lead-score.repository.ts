import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { leadScores } from "../schema";
import type { LeadScore, NewLeadScore } from "../schema";

export class LeadScoreRepository {
  constructor(private readonly db: Database) {}

  async findByCallId(callId: string): Promise<LeadScore | undefined> {
    return this.db.query.leadScores.findFirst({ where: eq(leadScores.callId, callId) });
  }

  async upsert(data: NewLeadScore): Promise<LeadScore> {
    const [row] = await this.db
      .insert(leadScores)
      .values(data)
      .onConflictDoUpdate({
        target: leadScores.callId,
        set: {
          score: data.score,
          label: data.label,
          rationale: data.rationale,
          signals: data.signals,
          timeline: data.timeline,
          campaignId: data.campaignId,
          crmLeadId: data.crmLeadId,
        },
      })
      .returning();
    if (!row) throw new Error("Upsert returned no rows");
    return row;
  }

  async applyOverride(
    callId: string,
    override: {
      overrideLabel: NonNullable<NewLeadScore["overrideLabel"]>;
      overrideReason: string;
      overrideBy: string;
    },
  ): Promise<LeadScore | undefined> {
    const [row] = await this.db
      .update(leadScores)
      .set({ ...override, overrideAt: new Date() })
      .where(eq(leadScores.callId, callId))
      .returning();
    return row;
  }
}
