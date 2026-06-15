import { Module } from "@nestjs/common";
import {
  CampaignRepository,
  CampaignTargetRepository,
  CallRepository,
  type Database,
} from "@pikorua/db";
import { DemoController } from "./demo.controller";

@Module({
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
    {
      provide: CallRepository,
      useFactory: (db: Database) => new CallRepository(db),
      inject: ["DATABASE"],
    },
  ],
  controllers: [DemoController],
})
export class DemoModule {}
