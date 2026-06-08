import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { PostCallProcessingService } from "./postcall.service";

@Injectable()
export class PostCallWorker implements OnModuleDestroy {
  private readonly logger = new Logger("PostCallWorker");
  private worker: Worker<{ callId: string }> | null = null;
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly processor: PostCallProcessingService,
  ) {
    this.start().catch((err) =>
      this.logger.error(
        "Failed to start PostCallWorker",
        err instanceof Error ? err.stack : String(err),
      ),
    );
  }

  private async start() {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    if (!redisUrl) {
      this.logger.warn("REDIS_URL not set; PostCallWorker disabled");
      return;
    }

    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.worker = new Worker<{ callId: string }>(
      "postcall",
      async (job: Job<{ callId: string }>) => {
        const callId = String(job.data?.callId ?? "");
        if (!callId) return;
        await this.processor.processCall(callId);
      },
      { connection: this.redis },
    );

    this.worker.on("failed", (job: Job<{ callId: string }> | undefined, err: Error) => {
      this.logger.error(`postcall job ${job?.id} failed: ${String(err)}`);
    });

    this.logger.log("PostCallWorker started");
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}
