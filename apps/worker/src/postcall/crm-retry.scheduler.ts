import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";

@Injectable()
export class CrmRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("CrmRetryScheduler");
  private queue: Queue | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const redis = String(this.config.get("REDIS_URL") ?? "");
    if (!redis) {
      this.logger.warn("REDIS_URL not set; CRM retry scheduler disabled");
      return;
    }

    this.queue = new Queue("crm-retry", { connection: redis });
    try {
      // Add a repeatable job that triggers the worker to scan pending CRM syncs
      await this.queue.add(
        "cron-trigger",
        {},
        { repeat: { cron: "*/5 * * * *" }, removeOnComplete: true, removeOnFail: false },
      );
      this.logger.log("Scheduled crm-retry repeatable job (every 5 minutes)");
    } catch (err) {
      this.logger.warn("Failed to schedule crm-retry job", err instanceof Error ? err.stack : String(err));
    }
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
  }
}
