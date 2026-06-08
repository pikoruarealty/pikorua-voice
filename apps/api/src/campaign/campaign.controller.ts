import { BadRequestException, Body, Controller, Logger, Post } from "@nestjs/common";
import { CampaignService } from "./campaign.service";
import { createCampaignSchema } from "./dto/create-campaign.dto";

@Controller("campaigns")
export class CampaignController {
  private readonly logger = new Logger("CampaignController");

  constructor(private readonly service: CampaignService) {}

  @Post()
  async create(@Body() body: unknown) {
    const parsed = createCampaignSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`Invalid create campaign payload: ${parsed.error.message}`);
      throw new BadRequestException("Invalid campaign payload");
    }

    return this.service.create(parsed.data);
  }
}
