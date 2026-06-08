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
      this.redis = new Redis(redisUrl);
      this.queue = new Queue("postcall", { connection: this.redis });
      this.logger.log("Postcall queue initialized");
    } else {
      this.logger.warn("REDIS_URL not set; postcall queue disabled");
    }
  }

  async enqueue(callId: string) {
    if (!this.queue) throw new Error("Postcall queue not initialized");
    await this.queue.add("postcall", { callId });
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}
