import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

@Injectable()
export class PostCallQueueService implements OnModuleDestroy {
  private readonly logger = new Logger("PostCallQueueService");
  private queue: Queue | null = null;
  private redis: Redis | null = null;

  constructor(private readonly config: ConfigService) {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    if (redisUrl) {
      this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
      this.queue = new Queue("postcall", { connection: this.redis });
      this.logger.log("Postcall queue initialized");
    } else {
      this.logger.warn("REDIS_URL not set; postcall queue disabled");
    }
  }

  async enqueue(callId: string) {
    if (!this.queue) throw new Error("Postcall queue not initialized");
    // Dedupe by callId: two near-simultaneous "completed" webhooks (e.g. retries
    // with slightly different event keys) must not spawn two post-call runs, which
    // would emit duplicate HOT alerts (call_events has no uniqueness). BullMQ drops
    // an add() whose jobId already exists. removeOnComplete bounds Redis growth.
    await this.queue.add(
      "postcall",
      { callId },
      { jobId: `postcall:${callId}`, removeOnComplete: true, removeOnFail: false },
    );
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}
