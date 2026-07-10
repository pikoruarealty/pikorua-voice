import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { CampaignTargetRepository } from "@pikorua/db";

@Injectable()
export class DialRepairScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("DialRepairScheduler");
  private timer: NodeJS.Timeout | null = null;
  private queue: Queue | null = null;
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly targetRepo: CampaignTargetRepository,
  ) {}

  async onModuleInit() {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    if (!redisUrl) {
      this.logger.warn("REDIS_URL not set; dial repair scheduler disabled");
      return;
    }

    this.redis = new Redis(redisUrl);
    this.queue = new Queue("dial", { connection: this.redis });
    // Without an 'error' listener a Queue error would crash the process.
    this.queue.on("error", (err: Error) => {
      this.logger.warn(`dial-repair queue error (non-fatal): ${String(err)}`);
    });
    this.timer = setInterval(() => void this.repair(), 60_000);
    this.timer.unref();
    await this.repair();
  }

  async repair() {
    if (!this.queue) {
      return;
    }

    const pending = await this.targetRepo.findRepairableDials(100);
    for (const target of pending) {
      await this.queue.add("dial-target", { targetId: target.id }, { jobId: `dial:${target.id}` });
      await this.targetRepo.updateDialStatus(target.id, "queued");
    }
    if (pending.length > 0) {
      this.logger.log(`Re-enqueued ${pending.length} pending dial target(s)`);
    }
  }

  async onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.queue?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}
