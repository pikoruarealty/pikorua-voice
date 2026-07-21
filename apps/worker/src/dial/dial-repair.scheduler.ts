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

  // MUST NEVER REJECT. It is driven by `setInterval(() => void this.repair(), …)`,
  // and `void` discards the promise — so a rejection here is an unhandled rejection,
  // which Node terminates the process for (verified: the worker exits rather than
  // continuing). Both awaits below talk to the network: Postgres via the repository
  // and Redis via the queue. A single Neon cold start, Upstash hiccup, or dropped
  // connection would therefore have killed the worker every 60 seconds — the same
  // "Exited with status 1" crash-loop shape as the unlistened BullMQ error events.
  //
  // onModuleInit also awaits this once at boot, where a rejection fails module init
  // and the worker never starts at all. Swallowing here covers that too.
  async repair() {
    if (!this.queue) {
      return;
    }

    try {
      const pending = await this.targetRepo.findRepairableDials(100);
      for (const target of pending) {
        await this.queue.add("dial-target", { targetId: target.id }, { jobId: `dial:${target.id}` });
        await this.targetRepo.updateDialStatus(target.id, "queued");
      }
      if (pending.length > 0) {
        this.logger.log(`Re-enqueued ${pending.length} pending dial target(s)`);
      }
    } catch (err) {
      // Next tick retries in 60s; repair is idempotent (jobId dedupes re-enqueues).
      this.logger.warn(`Dial repair pass failed (non-fatal, will retry): ${String(err)}`);
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
