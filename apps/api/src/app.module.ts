import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolve } from "path";
import { AppController } from "./app.controller";
import { validateEnv } from "./config/env";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { CampaignModule } from "./campaign/campaign.module";
import { WebhookModule } from "./webhooks/webhook.module";
import { CallRuntimeModule } from "./call-runtime/call-runtime.module";
import { MediaIngressModule } from "./media-ingress/media-ingress.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // __dirname is apps/api/dist at runtime — three levels up is the repo root.
      envFilePath: resolve(__dirname, "../../../.env"),
      validate: validateEnv,
    }),
    DatabaseModule,
    HealthModule,
    CampaignModule,
    WebhookModule,
    CallRuntimeModule,
    MediaIngressModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
