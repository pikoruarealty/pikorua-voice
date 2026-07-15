import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { WorkerWaker } from "../worker-waker/worker-waker.service";

@Injectable()
export class DialQueueService implements OnModuleDestroy {
  private readonly logger = new Logger("DialQueueService");
  private queue: Queue | null = null;
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly waker: WorkerWaker,
  ) {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    if (!redisUrl) {
      this.logger.warn("REDIS_URL not set; dial queue disabled");
      return;
    }

    this.redis = new Redis(redisUrl);
    this.queue = new Queue("dial", { connection: this.redis });
    this.logger.log("Dial queue initialized");
  }

  async enqueueTarget(targetId: string) {
    if (!this.queue) {
      throw new Error("Dial queue not initialized");
    }

    await this.queue.add(
      "dial-target",
      { targetId },
      {
        jobId: `dial:${targetId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 30000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    // Wake a spun-down worker so it actually places this outbound call, rather than
    // the dial job sitting in Redis until the worker happens to wake.
    this.waker.wake("dial");
  }

  async enqueueTargets(targetIds: string[]) {
    for (const targetId of targetIds) {
      await this.enqueueTarget(targetId);
    }
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}
