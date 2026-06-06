import { Module } from "@nestjs/common";
import { CampaignController } from "./campaign.controller";
import { CampaignService } from "./campaign.service";
import { CampaignRepository } from "@pikorua/db";

@Module({
  controllers: [CampaignController],
  providers: [
    {
      provide: CampaignRepository,
      useFactory: (db: any) => new CampaignRepository(db),
      inject: ["DATABASE"],
    },
    CampaignService,
  ],
})
export class CampaignModule {}
