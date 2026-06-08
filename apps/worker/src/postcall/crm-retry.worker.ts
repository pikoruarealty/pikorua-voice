import { Injectable, Logger, OnModuleDestroy, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { CrmSyncLogRepository } from "@pikorua/db";
import axios, { type AxiosError } from "axios";

@Injectable()
export class CrmRetryWorker implements OnModuleDestroy {
  private readonly logger = new Logger("CrmRetryWorker");
  private worker: Worker<Record<string, unknown>> | null = null;
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(CrmSyncLogRepository) private readonly crmLogRepo: CrmSyncLogRepository,
  ) {
    this.start().catch((err) =>
      this.logger.error(
        "Failed to start CRM retry worker",
        err instanceof Error ? err.stack : String(err),
      ),
    );
  }

  private async start() {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    if (!redisUrl) {
      this.logger.warn("REDIS_URL not set; CrmRetryWorker disabled");
      return;
    }

    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.worker = new Worker<Record<string, unknown>>(
      "crm-retry",
      async (_job: Job<Record<string, unknown>>) => {
        const pending = await this.crmLogRepo.findPending(25);
        for (const entry of pending) {
          try {
            const crmBase = String(this.config.get("CRM_API_BASE_URL") ?? "");
            const crmToken = String(this.config.get("CRM_API_TOKEN") ?? "");
            if (!crmBase) {
              await this.crmLogRepo.updateStatus(entry.id, "skipped", {
                responsePayload: { reason: "CRM not configured" },
              } as any);
              continue;
            }
            const url = `${crmBase.replace(/\/$/, "")}/leads`;
            const resp = await axios.post(url, entry.requestPayload, {
              headers: crmToken ? { Authorization: `Bearer ${crmToken}` } : undefined,
              timeout: 5000,
            });
            await this.crmLogRepo.updateStatus(entry.id, "success", {
              httpStatus: resp.status,
              responsePayload: resp.data,
              attempts: (entry.attempts ?? 0) + 1,
            } as any);
          } catch (err) {
            this.logger.warn(
              "Retry failed for crm sync",
              err instanceof Error ? err.stack : String(err),
            );
            const axiosErr = err as AxiosError;
            const status = axiosErr?.response?.status ?? null;
            const data = axiosErr?.response?.data ?? { message: String(err) };
            await this.crmLogRepo.updateStatus(entry.id, "failed", {
              httpStatus: status,
              responsePayload: data,
              attempts: (entry.attempts ?? 0) + 1,
              error: String(err),
            } as any);
          }
        }
      },
      { connection: this.redis, concurrency: 1 },
    );

    this.worker.on("failed", (job: Job<Record<string, unknown>> | undefined, err: Error) => {
      this.logger.error(`crm-retry job ${job?.id} failed: ${String(err)}`);
    });

    this.logger.log("CrmRetryWorker started");
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}
