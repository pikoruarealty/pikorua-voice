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
import { WorkerWakerModule } from "./worker-waker/worker-waker.module";
import { HealthModule } from "./health/health.module";
import { CostsModule } from "./costs/costs.module";
import { CampaignModule } from "./campaign/campaign.module";
import { AppointmentModule } from "./appointments/appointment.module";
import { WebhookModule } from "./webhooks/webhook.module";
import { CallRuntimeModule } from "./call-runtime/call-runtime.module";
import { MetricsModule } from "./metrics/metrics.module";
import { DemoModule } from "./demo/demo.module";

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
    WorkerWakerModule,
    HealthModule,
    CostsModule,
    CampaignModule,
    AppointmentModule,
    WebhookModule,
    CallRuntimeModule,
    MetricsModule,
    DemoModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ApiAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
