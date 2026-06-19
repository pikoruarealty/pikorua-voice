import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import axios from "axios";
import { CampaignRepository, CampaignTargetRepository, CallRepository } from "@pikorua/db";
import type { NewCall } from "@pikorua/db";
import { nextDialWindowAt } from "./dial-window";

@Injectable()
export class DialService implements OnModuleDestroy {
  private readonly logger = new Logger("DialService");
  private queue: Queue | null = null;
  private worker: Worker<Record<string, unknown>> | null = null;
  private queueRedis: Redis | null = null;
  private workerRedis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly campaignRepo: CampaignRepository,
    private readonly targetRepo: CampaignTargetRepository,
    private readonly callRepo: CallRepository,
  ) {
    this.start().catch((err) =>
      this.logger.error(
        "Failed to start dial service",
        err instanceof Error ? err.stack : String(err),
      ),
    );
  }

  private async start() {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "redis://localhost:6380");

    this.queueRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.queue = new Queue("dial", { connection: this.queueRedis });

    this.worker = new Worker<Record<string, unknown>>(
      "dial",
      async (job: Job<Record<string, unknown>>) => {
        await this.processJob(job.data);
      },
      { connection: this.workerRedis },
    );

    this.worker.on("failed", (job: Job<Record<string, unknown>> | undefined, err: Error) => {
      this.logger.error(`Dial job ${job?.id} failed: ${String(err)}`);
    });

    this.logger.log("Dial queue started and worker attached");
  }

  async enqueue(targetId: string) {
    if (!this.queue) throw new Error("Queue not initialized");
    await this.queue.add("dial-target", { targetId }, { jobId: `dial:${targetId}` });
  }

  private async processJob(data: Record<string, unknown>) {
    const targetId = String(data["targetId"] ?? "");
    if (!targetId) {
      this.logger.warn("Dial job missing targetId");
      return;
    }

    const target = await this.targetRepo.findById(targetId);
    if (!target) {
      this.logger.warn(`Target not found: ${targetId}`);
      return;
    }
    if (["do_not_call", "exhausted", "completed"].includes(target.dialStatus)) {
      this.logger.log(`Skipping target ${target.id}; dialStatus=${target.dialStatus}`);
      return;
    }

    const campaign = await this.campaignRepo.findById(target.campaignId);
    if (!campaign || campaign.status !== "active") {
      await this.targetRepo.updateDialStatus(target.id, "pending");
      this.logger.log(`Skipping target ${target.id}; campaign is not active`);
      return;
    }

    const nextWindowAt = nextDialWindowAt(campaign, new Date());
    if (nextWindowAt) {
      await this.targetRepo.updateDialStatus(target.id, "pending", {
        nextAttemptAt: nextWindowAt,
      });
      this.logger.log(`Deferring target ${target.id} until ${nextWindowAt.toISOString()}`);
      return;
    }

    const attempts = (target.attempts ?? 0) + 1;
    await this.targetRepo.updateDialStatus(target.id, "dialing", {
      attempts,
      lastAttemptAt: new Date(),
    });

    const newCall: NewCall = {
      campaignId: target.campaignId,
      targetId: target.id,
      crmLeadId: target.crmLeadId,
      fromNumber: String(this.config.get("EXOTEL_CALLER_ID") ?? ""),
      toNumber: target.phone,
      locale: target.locale ?? "en-IN",
      status: "queued",
    } as NewCall;

    const call = await this.callRepo.create(newCall);
    this.logger.log(`Created call ${call.id} for target ${target.id}`);

    const sid = this.config.get("EXOTEL_SID");
    const key = this.config.get("EXOTEL_API_KEY");
    const token = this.config.get("EXOTEL_API_TOKEN");
    const subdomain = String(this.config.get("EXOTEL_SUBDOMAIN") ?? "api.exotel.com");
    const publicBaseUrl = String(this.config.get("PUBLIC_BASE_URL") ?? "").replace(/\/$/, "");

    if (sid && key && token) {
      try {
        const url = `https://${subdomain}/v1/Accounts/${String(sid)}/Calls/connect.json`;
        const params = new URLSearchParams({
          From: call.fromNumber ?? "",
          To: call.toNumber ?? "",
          CallerId: String(this.config.get("EXOTEL_CALLER_ID") ?? ""),
        });
        // Route the answered call through the Voicebot app configured in the
        // Exotel dashboard. Without AppId, Exotel has no behaviour to run.
        const appId = this.config.get("EXOTEL_APP_ID");
        if (appId) params.set("AppId", String(appId));
        if (publicBaseUrl) {
          params.set("StatusCallback", `${publicBaseUrl}/api/webhooks/exotel`);
          params.set("StatusCallbackContentType", "application/json");
          params.append("StatusCallbackEvents[]", "answered");
          params.append("StatusCallbackEvents[]", "terminal");
        }

        const resp = await axios.post(url, params.toString(), {
          auth: { username: String(key), password: String(token) },
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 10000,
        });
        const providerSid: string | undefined = resp.data?.Call?.Sid ?? resp.data?.sid ?? undefined;
        await this.callRepo.update(call.id, {
          providerCallSid: providerSid ? String(providerSid) : undefined,
          status: "initiated",
        });
        await this.targetRepo.updateDialStatus(target.id, "dialing");
        this.logger.log(`Placed Exotel call for ${call.id} (providerSid=${providerSid ?? "n/a"})`);
      } catch (err) {
        this.logger.error(
          `Exotel call failed for call ${call.id}`,
          err instanceof Error ? err.stack : String(err),
        );
        await this.callRepo.update(call.id, { status: "failed", error: String(err) });
        await this.targetRepo.updateDialStatus(
          target.id,
          attempts >= (target.maxAttempts ?? 3) ? "exhausted" : "failed",
        );
      }
    } else {
      this.logger.warn("Exotel not configured; leaving call queued without provider dispatch");
      await this.targetRepo.updateDialStatus(target.id, "queued");
    }
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    await this.workerRedis?.quit().catch(() => undefined);
    await this.queueRedis?.quit().catch(() => undefined);
  }
}
