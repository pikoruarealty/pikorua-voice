import { Module } from "@nestjs/common";
import { CampaignController } from "./campaign.controller";
import { CampaignService } from "./campaign.service";
import { CampaignRepository, CampaignTargetRepository, type Database } from "@pikorua/db";
import { DialQueueService } from "./dial-queue.service";

@Module({
  controllers: [CampaignController],
  providers: [
    {
      provide: CampaignRepository,
      useFactory: (db: Database) => new CampaignRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CampaignTargetRepository,
      useFactory: (db: Database) => new CampaignTargetRepository(db),
      inject: ["DATABASE"],
    },
    DialQueueService,
    CampaignService,
  ],
})
export class CampaignModule {}
