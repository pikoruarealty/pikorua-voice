import { Injectable, Inject, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import crypto from "crypto";
import {
  WebhookEventRepository,
  CallRepository,
  CallEventRepository,
  CampaignTargetRepository,
} from "@pikorua/db";
import type { WebhookEvent } from "@pikorua/db";
import { PostCallQueueService } from "../postcall/postcall.queue";
import { IvrService } from "../ivr/ivr.service";
import type { ExotelWebhookDto } from "./exotel.dto";

@Injectable()
export class WebhookService {
  private readonly logger = new Logger("WebhookService");

  constructor(
    private readonly config: ConfigService,
    @Inject(WebhookEventRepository) private readonly webhookRepo: WebhookEventRepository,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
    @Inject(CallEventRepository) private readonly eventRepo: CallEventRepository,
    @Inject(CampaignTargetRepository) private readonly targetRepo: CampaignTargetRepository,
    private readonly postcallQueue: PostCallQueueService,
    private readonly ivr: IvrService,
  ) {}

  verifySignature(secret: string | undefined, rawBody: string, headerSig?: string | null) {
    if (!secret || !headerSig) return false;
    try {
      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      const provided = headerSig.replace(/^sha256=/i, "").trim();
      const expectedBuffer = Buffer.from(expected, "hex");
      const providedBuffer = Buffer.from(provided, "hex");
      return (
        expectedBuffer.length === providedBuffer.length &&
        crypto.timingSafeEqual(expectedBuffer, providedBuffer)
      );
    } catch (err) {
      this.logger.warn(
        "Signature verification error",
        err instanceof Error ? err.stack : String(err),
      );
      return false;
    }
  }

  async handleExotel(rawBody: string, payload: ExotelWebhookDto, headerSig?: string | null) {
    const secret = this.config.get("EXOTEL_WEBHOOK_SECRET");
    const signatureValid = this.verifySignature(secret as string | undefined, rawBody, headerSig);
    if (secret && !signatureValid) {
      throw new UnauthorizedException("Invalid Exotel webhook signature");
    }

    const providerCallSid = String(payload.CallSid ?? payload.Sid ?? "");
    const eventType = String(payload.Event ?? payload.CallStatus ?? "unknown");

    // Idempotency: skip duplicate events with identical raw payload
    try {
      const existing = providerCallSid
        ? await this.webhookRepo.findByProviderCallSid(providerCallSid)
        : [];
      const payloadJson = JSON.stringify(payload);
      const already = existing.find((e) => JSON.stringify(e.rawPayload) === payloadJson);
      if (already) {
        this.logger.log(`Duplicate webhook for sid=${providerCallSid}; ignoring`);
        return { status: "ignored" } as const;
      }
    } catch (err) {
      this.logger.warn(
        "Failed to check existing webhooks",
        err instanceof Error ? err.stack : String(err),
      );
    }

    // Persist webhook event (Rule 10: inbound webhook received)
    let eventRow: WebhookEvent | undefined;
    try {
      eventRow = await this.webhookRepo.create({
        provider: "exotel",
        eventType,
        providerCallSid: providerCallSid || null,
        rawPayload: payload as unknown as Record<string, unknown>,
        signatureValid: !!signatureValid,
      });
      this.logger.log(
        `Inbound webhook: id=${eventRow.id} sid=${providerCallSid} event=${eventType}`,
      );
    } catch (err) {
      this.logger.error(
        "Failed to persist webhook event",
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }

    // Correlate to a call row and update its status
    if (providerCallSid) {
      try {
        const call = await this.callRepo.findByProviderCallSid(providerCallSid);
        if (call) {
          const statusMap: Record<string, string> = {
            ringing: "ringing",
            answered: "in_progress",
            in_progress: "in_progress",
            initiated: "initiated",
            completed: "completed",
            "no-answer": "no_answer",
            no_answer: "no_answer",
            busy: "busy",
            failed: "failed",
          };
          const mappedStatus =
            statusMap[
              String(
                payload.CallStatus ?? payload.Status ?? payload.Event ?? payload.EventType ?? "",
              ).toLowerCase()
            ];

          if (mappedStatus) {
            const terminal = ["completed", "no_answer", "busy", "failed", "canceled"].includes(
              mappedStatus,
            );
            const duration = Number(payload.ConversationDuration ?? NaN);
            await this.callRepo.updateByProviderCallSid(providerCallSid, {
              status: mappedStatus as any,
              endedAt: terminal ? new Date() : undefined,
              answeredAt: mappedStatus === "in_progress" ? new Date() : undefined,
              recordingUrl: payload.RecordingUrl,
              durationSeconds: Number.isFinite(duration) ? duration : undefined,
              hangupCause: payload.HangupCause,
            });
            if (call.targetId && terminal) {
              const targetStatus =
                mappedStatus === "completed"
                  ? "completed"
                  : mappedStatus === "no_answer"
                    ? "no_answer"
                    : mappedStatus === "busy"
                      ? "busy"
                      : "failed";
              await this.targetRepo.updateDialStatus(call.targetId, targetStatus as any);
            }
            if (mappedStatus === "completed") {
              try {
                await this.postcallQueue.enqueue(call.id);
              } catch (queueErr) {
                this.logger.warn(
                  "Failed to enqueue post-call job",
                  queueErr instanceof Error ? queueErr.stack : String(queueErr),
                );
              }
            }
          }

          // Map IVR DTMF digit to locale
          try {
            const digits = String(payload.Digits ?? "");
            if (digits) {
              const ivrResult = this.ivr.mapDigitToLocale(digits);
              await this.callRepo.update(call.id, { locale: ivrResult.locale as any });
              await this.eventRepo.create({
                callId: call.id,
                campaignId: call.campaignId ?? null,
                type: "escalation",
                severity: "info",
                message: `IVR selection: ${digits} -> ${ivrResult.locale}`,
                payload: { digits, mapped: ivrResult },
              } as any);
            }
          } catch (ivrErr) {
            this.logger.warn(
              "Failed to process IVR digits",
              ivrErr instanceof Error ? ivrErr.stack : String(ivrErr),
            );
          }
        }
      } catch (err) {
        this.logger.error(
          "Failed to correlate webhook to call",
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    // Mark processed
    if (eventRow) {
      try {
        await this.webhookRepo.markProcessed(eventRow.id);
      } catch (err) {
        this.logger.warn(
          "Failed to mark webhook processed",
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return { status: "processed" } as const;
  }
}
