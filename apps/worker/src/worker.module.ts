import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolve } from "path";
import { validateWorkerEnv } from "./config/env";
import { HealthController } from "./health.controller";
import { KeepAliveScheduler } from "./keepalive.scheduler";
import { DatabaseModule } from "./database/database.module";
import { DialService } from "./dial/dial.service";
import { DialRepairScheduler } from "./dial/dial-repair.scheduler";
import {
  CampaignRepository,
  CampaignTargetRepository,
  CallRepository,
  LeadScoreRepository,
  CrmSyncLogRepository,
  CallEventRepository,
  CallTurnRepository,
  AppointmentRepository,
  type Database,
} from "@pikorua/db";
import { AppointmentScheduler } from "./appointments/appointment.scheduler";
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
  controllers: [HealthController],
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
    {
      provide: LeadScoreRepository,
      useFactory: (db: Database) => new LeadScoreRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CrmSyncLogRepository,
      useFactory: (db: Database) => new CrmSyncLogRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallEventRepository,
      useFactory: (db: Database) => new CallEventRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallTurnRepository,
      useFactory: (db: Database) => new CallTurnRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: AppointmentRepository,
      useFactory: (db: Database) => new AppointmentRepository(db),
      inject: ["DATABASE"],
    },
    DialService,
    DialRepairScheduler,
    KeepAliveScheduler,
    LeadScoreLlmService,
    PostCallProcessingService,
    PostCallWorker,
    CrmRetryWorker,
    CrmRetryScheduler,
    AppointmentScheduler,
  ],
})
export class WorkerModule {}
