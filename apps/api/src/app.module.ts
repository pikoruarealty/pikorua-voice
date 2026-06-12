import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { resolve } from "path";
import { AppController } from "./app.controller";
import { ApiAuthGuard } from "./auth/api-auth.guard";
import { validateEnv } from "./config/env";
import { DatabaseModule } from "./database/database.module";
import { RedisModule } from "./redis/redis.module";
import { HealthModule } from "./health/health.module";
import { CampaignModule } from "./campaign/campaign.module";
import { WebhookModule } from "./webhooks/webhook.module";
import { CallRuntimeModule } from "./call-runtime/call-runtime.module";
import { MediaIngressModule } from "./media-ingress/media-ingress.module";
import { MetricsModule } from "./metrics/metrics.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // __dirname is apps/api/dist at runtime — three levels up is the repo root.
      envFilePath: resolve(__dirname, "../../../.env"),
      validate: validateEnv,
    }),
    // Global rate limits: 120 req/min per IP on all endpoints (protects
    // campaign creation, webhook ingestion, call-turn API).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    RedisModule,
    HealthModule,
    CampaignModule,
    WebhookModule,
    CallRuntimeModule,
    MediaIngressModule,
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ApiAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
