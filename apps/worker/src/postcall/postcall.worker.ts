import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";
import { PostCallProcessingService } from "./postcall.service";

@Injectable()
export class PostCallWorker implements OnModuleDestroy {
  private readonly logger = new Logger("PostCallWorker");
  private worker: Worker | null = null;

  constructor(private readonly config: ConfigService, private readonly processor: PostCallProcessingService) {
    this.start().catch((err) => this.logger.error("Failed to start PostCallWorker", err instanceof Error ? err.stack : String(err)));
  }

  private async start() {
    const redis = String(this.config.get("REDIS_URL") ?? "");
    if (!redis) {
      this.logger.warn("REDIS_URL not set; PostCallWorker disabled");
      return;
    }

    this.worker = new Worker(
      "postcall",
      async (job) => {
        const callId = String(job.data?.callId ?? "");
        if (!callId) return;
        await this.processor.processCall(callId);
      },
      { connection: redis },
    );

    this.worker.on("failed", (job, err) => {
      this.logger.error(`postcall job ${job?.id} failed: ${String(err)}`);
    });

    this.logger.log("PostCallWorker started");
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
  }
}
