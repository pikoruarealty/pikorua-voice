import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import crypto from "crypto";
import { WebhookEventRepository, CallRepository, CallEventRepository } from "@pikorua/db";
import { PostCallQueueService } from "../postcall/postcall.queue";
import type { ExotelWebhookDto } from "./exotel.dto";

@Injectable()
export class WebhookService {
  private readonly logger = new Logger("WebhookService");

  constructor(
    private readonly config: ConfigService,
    @Inject(WebhookEventRepository) private readonly webhookRepo: WebhookEventRepository,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
    @Inject(CallEventRepository) private readonly eventRepo: CallEventRepository,
    private readonly postcallQueue: PostCallQueueService,
    private readonly ivr: IvrService,
  ) {}

  verifySignature(secret: string | undefined, rawBody: string, headerSig?: string | null) {
    if (!secret) return false;
    if (!headerSig) return false;
    try {
      const h = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(headerSig));
    } catch (err) {
      this.logger.warn("Signature verification error", err instanceof Error ? err.stack : String(err));
      return false;
    }
  }

  async handleExotel(rawBody: string, payload: ExotelWebhookDto, headerSig?: string | null) {
    const secret = this.config.get("EXOTEL_WEBHOOK_SECRET");
    const signatureValid = this.verifySignature(secret as string | undefined, rawBody, headerSig);

    const providerCallSid = String(payload.CallSid ?? payload.Sid ?? "");
    const eventType = String(payload.Event ?? payload.CallStatus ?? "unknown");

    // Idempotency: check existing events for identical raw payload
    try {
      const existing = providerCallSid ? await this.webhookRepo.findByProviderCallSid(providerCallSid) : [];
      const already = existing.find((e) => JSON.stringify(e.rawPayload) === rawBody);
      if (already) {
        this.logger.log(`Duplicate webhook received for sid=${providerCallSid}; marking ignored`);
        return { status: "ignored" } as const;
      }
    } catch (err) {
      this.logger.warn("Failed to check existing webhooks", err instanceof Error ? err.stack : String(err));
    }

    // Persist webhook event
    let eventRow;
    try {
      eventRow = await this.webhookRepo.create({
        provider: "exotel",
        eventType,
        providerCallSid: providerCallSid || null,
        rawPayload: payload as unknown as Record<string, unknown>,
        signatureValid: !!signatureValid,
      });
      this.logger.log(`Inbound webhook received: id=${eventRow.id} sid=${providerCallSid} event=${eventType}`);
    } catch (err) {
      this.logger.error("Failed to persist webhook event", err instanceof Error ? err.stack : String(err));
      throw err;
    }

    // Correlate to call and update status
    if (providerCallSid) {
      try {
        const call = await this.callRepo.findByProviderCallSid(providerCallSid);
        if (call) {
          // Map provider statuses to internal call statuses conservatively
          const statusMap: Record<string, string> = {
            ringing: "ringing",
            in_progress: "in_progress",
            initiated: "initiated",
            completed: "completed",
            no_answer: "no_answer",
            busy: "busy",
            failed: "failed",
          };
          const mapped = statusMap[String(payload.CallStatus ?? payload.Event ?? "").toLowerCase()] ?? undefined;
            if (mapped) {
              await this.callRepo.updateByProviderCallSid(providerCallSid, { status: mapped as any });
              await this.eventRepo.create({ callId: call.id, campaignId: call.campaignId ?? null, type: "worker_failure", severity: "info", message: `Provider event: ${eventType}`, payload: payload as unknown as Record<string, unknown> });
              // If call completed, enqueue post-call processing
              if (mapped === "completed") {
                try {
                  await this.postcallQueue.enqueue(call.id);
                } catch (err) {
                  this.logger.warn("Failed to enqueue post-call job", err instanceof Error ? err.stack : String(err));
                }
              }
            }
            // If IVR DTMF digits provided, map and persist locale/provider
            try {
              const digits = String(payload.Digits ?? "");
              if (digits) {
                const mapped = this.ivr.mapDigitToLocale(digits);
                await this.callRepo.update(call.id, { locale: mapped.locale as any });
                await this.eventRepo.create({ callId: call.id, campaignId: call.campaignId ?? null, type: "escalation", severity: "info", message: `IVR selection: ${digits} -> ${mapped.locale}`, payload: { digits, mapped } });
              }
            } catch (err) {
              this.logger.warn("Failed to process IVR digits", err instanceof Error ? err.stack : String(err));
            }
          }
        }
      } catch (err) {
        this.logger.error("Failed to correlate webhook to call", err instanceof Error ? err.stack : String(err));
      }
    }

    // Mark processed
    try {
      await this.webhookRepo.markProcessed(eventRow.id);
    } catch (err) {
      this.logger.warn("Failed to mark webhook processed", err instanceof Error ? err.stack : String(err));
    }

    return { status: "processed" } as const;
  }
}
