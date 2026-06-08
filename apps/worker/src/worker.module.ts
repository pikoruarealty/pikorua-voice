import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolve } from "path";
import { validateWorkerEnv } from "./config/env";
import { DatabaseModule } from "./database/database.module";
import { DialService } from "./dial/dial.service";
import { DialRepairScheduler } from "./dial/dial-repair.scheduler";
import {
  CampaignTargetRepository,
  CallRepository,
  LeadScoreRepository,
  CrmSyncLogRepository,
  CallEventRepository,
  CallTurnRepository,
} from "@pikorua/db";
import { PostCallProcessingService } from "./postcall/postcall.service";
import { LeadScoreLlmService } from "./postcall/lead-score-llm.service";
import { PostCallWorker } from "./postcall/postcall.worker";
import { CrmRetryWorker } from "./postcall/crm-retry.worker";
import { CrmRetryScheduler } from "./postcall/crm-retry.scheduler";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // __dirname is apps/worker/dist at runtime — three levels up is the repo root.
      envFilePath: resolve(__dirname, "../../../.env"),
      validate: validateWorkerEnv,
    }),
    DatabaseModule,
  ],
  providers: [
    {
      provide: CampaignTargetRepository,
      useFactory: (db: any) => new CampaignTargetRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallRepository,
      useFactory: (db: any) => new CallRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: LeadScoreRepository,
      useFactory: (db: any) => new LeadScoreRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CrmSyncLogRepository,
      useFactory: (db: any) => new CrmSyncLogRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallEventRepository,
      useFactory: (db: any) => new CallEventRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallTurnRepository,
      useFactory: (db: any) => new CallTurnRepository(db),
      inject: ["DATABASE"],
    },
    DialService,
    DialRepairScheduler,
    LeadScoreLlmService,
    PostCallProcessingService,
    PostCallWorker,
    CrmRetryWorker,
    CrmRetryScheduler,
  ],
})
export class WorkerModule {}
