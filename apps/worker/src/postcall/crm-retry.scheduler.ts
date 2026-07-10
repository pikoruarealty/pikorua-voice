import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

@Injectable()
export class CrmRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("CrmRetryScheduler");
  private queue: Queue | null = null;
  private redis: Redis | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    if (!redisUrl) {
      this.logger.warn("REDIS_URL not set; CRM retry scheduler disabled");
      return;
    }

    this.redis = new Redis(redisUrl);
    this.queue = new Queue("crm-retry", { connection: this.redis });
    // Without an 'error' listener a Queue error would crash the process.
    this.queue.on("error", (err: Error) => {
      this.logger.warn(`crm-retry queue error (non-fatal): ${String(err)}`);
    });

    try {
      // Repeatable job that triggers the CrmRetryWorker every 5 minutes.
      // BullMQ v4+: use `pattern` (not `cron`) for cron expressions.
      await this.queue.add(
        "cron-trigger",
        {},
        {
          repeat: { pattern: "*/5 * * * *" },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log("Scheduled crm-retry repeatable job (every 5 minutes)");
    } catch (err) {
      this.logger.warn(
        "Failed to schedule crm-retry job",
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}
