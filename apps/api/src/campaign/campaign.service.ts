import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { CampaignRepository } from "@pikorua/db";
import type { NewCampaign } from "@pikorua/db";
import type { CreateCampaignDto } from "./dto/create-campaign.dto";

@Injectable()
export class CampaignService {
  private readonly logger = new Logger("CampaignService");

  constructor(private readonly repo: CampaignRepository) {}

  async create(dto: CreateCampaignDto) {
    try {
      const data: NewCampaign = {
        name: dto.name,
        source: dto.source,
        defaultLocale: dto.defaultLocale || "en-IN",
        scriptRef: dto.scriptRef || "default",
        dialWindowStart: dto.dialWindowStart,
        dialWindowEnd: dto.dialWindowEnd,
        maxAttempts: dto.maxAttempts ?? 3,
        notes: dto.notes,
      } as NewCampaign;

      const created = await this.repo.create(data);
      return created;
    } catch (err) {
      this.logger.error("Failed to create campaign", err instanceof Error ? err.stack : String(err));
      throw new InternalServerErrorException("Could not create campaign");
    }
  }
}
