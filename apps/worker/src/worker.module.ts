import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolve } from "path";
import { validateWorkerEnv } from "./config/env";
import { DatabaseModule } from "./database/database.module";
import { DialService } from "./dial/dial.service";
import { CampaignTargetRepository, CallRepository } from "@pikorua/db";

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
    DialService,
  ],
})
export class WorkerModule {}
