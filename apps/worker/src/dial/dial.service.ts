import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker, Job, DelayedError } from "bullmq";
import { Redis } from "ioredis";
import axios from "axios";
import { CampaignRepository, CampaignTargetRepository, CallRepository } from "@pikorua/db";
import type { NewCall } from "@pikorua/db";
import { CallSlots } from "@pikorua/shared";
import { nextDialWindowAt } from "./dial-window";

// While every call slot is busy, a dial job is pushed back this long and retried.
const SLOT_RETRY_DELAY_MS = 20_000;

@Injectable()
export class DialService implements OnModuleDestroy {
  private readonly logger = new Logger("DialService");
  private queue: Queue | null = null;
  private worker: Worker<Record<string, unknown>> | null = null;
  private queueRedis: Redis | null = null;
  private workerRedis: Redis | null = null;
  private slots: CallSlots | null = null;

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

    this.slots = new CallSlots(
      this.queueRedis,
      Number(this.config.get("MAX_CONCURRENT_CALLS") ?? 2),
      Number(this.config.get("OUTBOUND_MAX_CONCURRENT") ?? 1),
    );

    this.queue = new Queue("dial", { connection: this.queueRedis });
    // A Queue emits 'error' too; without a listener it would crash the process.
    this.queue.on("error", (err: Error) => {
      this.logger.warn(`dial queue error (non-fatal): ${String(err)}`);
    });

    this.worker = new Worker<Record<string, unknown>>(
      "dial",
      async (job: Job<Record<string, unknown>>, token?: string) => {
        await this.processJob(job, token);
      },
      { connection: this.workerRedis },
    );

    this.worker.on("failed", (job: Job<Record<string, unknown>> | undefined, err: Error) => {
      this.logger.error(`Dial job ${job?.id} failed: ${String(err)}`);
    });

    // An unhandled 'error' event (e.g. BullMQ's stalled-job check erroring
    // against Redis) would crash the process — log it and keep running.
    this.worker.on("error", (err: Error) => {
      this.logger.warn(`dial worker error (non-fatal): ${String(err)}`);
    });

    this.logger.log("Dial queue started and worker attached");
  }

  async enqueue(targetId: string) {
    if (!this.queue) throw new Error("Queue not initialized");
    await this.queue.add("dial-target", { targetId }, { jobId: `dial:${targetId}` });
  }

  private async processJob(job: Job<Record<string, unknown>>, jobToken?: string) {
    const data = job.data;
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

    // Call-slot gate: reserve a slot BEFORE dialing, so a campaign can never run
    // more calls at once than the box can carry. All busy → retry the same job
    // later (nothing is lost, the target stays pending). The slot is renamed to
    // the callId below; the gateway heartbeats it once answered, and a terminal
    // status webhook (or the stale reap) frees it.
    const slotMember = `dial:${target.id}`;
    if (this.slots && !(await this.slots.acquire(slotMember, "outbound"))) {
      this.logger.log(`All call slots busy — retrying target ${target.id} in ${SLOT_RETRY_DELAY_MS}ms`);
      await job.moveToDelayed(Date.now() + SLOT_RETRY_DELAY_MS, jobToken);
      throw new DelayedError();
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
    await this.slots?.rename(slotMember, call.id);

    const sid = this.config.get("EXOTEL_SID");
    const key = this.config.get("EXOTEL_API_KEY");
    const token = this.config.get("EXOTEL_API_TOKEN");
    const subdomain = String(this.config.get("EXOTEL_SUBDOMAIN") ?? "api.exotel.com");
    const publicBaseUrl = String(this.config.get("PUBLIC_BASE_URL") ?? "").replace(/\/$/, "");

    if (sid && key && token) {
      try {
        const url = `https://${subdomain}/v1/Accounts/${String(sid)}/Calls/connect.json`;
        // Exotel's `From` is the leg it dials FIRST — i.e. the person we want to
        // reach — NOT the number we call from. `CallerId` is what they see. Passing
        // the exophone as `From` (as this did) makes Exotel ring its own virtual
        // number, connect THAT to the applet, and play the whole pitch to a dead
        // leg: the callee's phone never rings, yet the call bills and records
        // normally, so it looks like a delivered call in every log.
        //
        // Our DB keeps fromNumber=exophone / toNumber=callee (business → customer,
        // which is what the CRM payload expects), so the mapping is deliberately
        // inverted here rather than at the column level.
        const params = new URLSearchParams({
          From: call.toNumber ?? "",
          CallerId: String(this.config.get("EXOTEL_CALLER_ID") ?? ""),
        });
        // The Voicebot applet is the SECOND leg, so no `To` is sent. It must be
        // passed as a flow `Url`; `AppId` is rejected by connect.json with
        // "Invalid 'To' specified" because that param expects a real destination.
        const appId = this.config.get("EXOTEL_APP_ID");
        if (appId) {
          params.set("Url", `http://my.exotel.com/${String(sid)}/exoml/start_voice/${String(appId)}`);
        }
        if (publicBaseUrl) {
          // Exotel does not sign status callbacks, so the shared secret rides in
          // the URL — it is the only channel Exotel gives us to authenticate the
          // callback. Without it the API rejects every callback with a 401 and no
          // call lifecycle / post-call processing ever runs.
          const webhookSecret = String(this.config.get("EXOTEL_WEBHOOK_SECRET") ?? "");
          const callbackUrl = webhookSecret
            ? `${publicBaseUrl}/api/webhooks/exotel?token=${encodeURIComponent(webhookSecret)}`
            : `${publicBaseUrl}/api/webhooks/exotel`;
          params.set("StatusCallback", callbackUrl);
          params.set("StatusCallbackContentType", "application/json");
          // NOTE: do NOT send StatusCallbackEvents[]. This account's connect.json
          // rejects it outright — "Invalid Call Parameters: Invalid
          // 'StatusCallbackEvents' specified" (HTTP 400) — which fails the ENTIRE
          // dial, so the callee's phone never rings. Exotel still POSTs the status
          // callback on the terminal (call-completed) event by default, which is
          // all post-call processing needs. Re-introduce per-event subscription
          // only against an account/plan confirmed to accept it.
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
        // Surface Exotel's ACTUAL rejection, not just the axios stack. connect.json
        // returns the reason in the body ({"RestException":{"Message":"..."}}); a
        // bare "status code 400" hides which param it refused and turned a
        // one-line diagnosis into a live-call guessing game.
        const body = axios.isAxiosError(err) ? err.response?.data : undefined;
        const exotelMsg =
          (body as { RestException?: { Message?: string } })?.RestException?.Message ??
          (typeof body === "string" ? body : body ? JSON.stringify(body) : undefined);
        this.logger.error(
          `Exotel call failed for call ${call.id}${exotelMsg ? ` — ${exotelMsg}` : ""}`,
          err instanceof Error ? err.stack : String(err),
        );
        await this.callRepo.update(call.id, {
          status: "failed",
          error: exotelMsg ? String(exotelMsg) : String(err),
        });
        await this.slots?.release(call.id);
        await this.targetRepo.updateDialStatus(
          target.id,
          attempts >= (target.maxAttempts ?? 3) ? "exhausted" : "failed",
        );
      }
    } else {
      this.logger.warn("Exotel not configured; leaving call queued without provider dispatch");
      await this.slots?.release(call.id);
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
