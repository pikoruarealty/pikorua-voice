import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { CampaignRepository, CampaignTargetRepository } from "@pikorua/db";
import type { NewCampaign, NewCampaignTarget } from "@pikorua/db";
import type { CreateCampaignDto } from "./dto/create-campaign.dto";
import { DialQueueService } from "./dial-queue.service";

@Injectable()
export class CampaignService {
  private readonly logger = new Logger("CampaignService");

  constructor(
    private readonly repo: CampaignRepository,
    private readonly targetRepo: CampaignTargetRepository,
    private readonly dialQueue: DialQueueService,
  ) {}

  async create(dto: CreateCampaignDto) {
    try {
      const data: NewCampaign = {
        name: dto.name,
        status: dto.status ?? "draft",
        source: dto.source,
        defaultLocale: dto.defaultLocale || "en-IN",
        scriptRef: dto.scriptRef || "default",
        dialWindowStart: dto.dialWindowStart,
        dialWindowEnd: dto.dialWindowEnd,
        maxAttempts: dto.maxAttempts ?? 3,
        notes: dto.notes,
      } as NewCampaign;

      const created = await this.repo.create(data);
      const targets = await this.targetRepo.createMany(
        (dto.targets ?? []).map(
          (target): NewCampaignTarget => ({
            campaignId: created.id,
            crmLeadId: target.crmLeadId,
            fullName: target.fullName,
            phone: target.phone,
            locale: target.locale ?? created.defaultLocale,
            maxAttempts: target.maxAttempts ?? created.maxAttempts,
            metadata: target.metadata,
          }),
        ),
      );

      let queuedTargets = 0;
      if (created.status === "active" && targets.length > 0) {
        await this.dialQueue.enqueueTargets(targets.map((target) => target.id));
        queuedTargets = targets.length;
      }

      return { campaign: created, targets, queuedTargets };
    } catch (err) {
      this.logger.error(
        "Failed to create campaign",
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException("Could not create campaign");
    }
  }
}
