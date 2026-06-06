import { Controller, Post, Body, Logger } from "@nestjs/common";
import { CampaignService } from "./campaign.service";
import { createCampaignSchema } from "./dto/create-campaign.dto";

@Controller("api/campaigns")
export class CampaignController {
  private readonly logger = new Logger("CampaignController");

  constructor(private readonly service: CampaignService) {}

  @Post()
  async create(@Body() body: unknown) {
    try {
      const parsed = createCampaignSchema.parse(body);
      const created = await this.service.create(parsed);
      return created;
    } catch (err) {
      this.logger.warn("Invalid create campaign payload or creation failed", err instanceof Error ? err.stack : String(err));
      throw err;
    }
  }
}
