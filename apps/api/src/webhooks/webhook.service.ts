import { Injectable, Inject, Logger, UnauthorizedException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import crypto from "crypto";
import {
  WebhookEventRepository,
  CallRepository,
  CallEventRepository,
  CampaignTargetRepository,
} from "@pikorua/db";
import type { Call, CampaignTarget, NewCallEvent, WebhookEvent } from "@pikorua/db";
import { PostCallQueueService } from "../postcall/postcall.queue";
import { IvrService } from "../ivr/ivr.service";
import { CallRuntimeService } from "../call-runtime/call-runtime.service";
import type { ExotelWebhookDto } from "./exotel.dto";
import type { CallSlots } from "@pikorua/shared";
import { CALL_SLOTS } from "../redis/redis.module";

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
    @Optional() private readonly callRuntime: CallRuntimeService | null,
    @Optional() @Inject(CALL_SLOTS) private readonly slots: CallSlots | null,
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

  // Constant-time compare of the shared secret carried in the callback URL.
  private urlTokenValid(secret: string | undefined, token?: string | null): boolean {
    if (!secret || !token) return false;
    const a = Buffer.from(String(secret));
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async handleExotel(
    rawBody: string,
    payload: ExotelWebhookDto,
    headerSig?: string | null,
    urlToken?: string | null,
  ) {
    const secret = this.config.get("EXOTEL_WEBHOOK_SECRET") as string | undefined;
    const signatureValid = this.verifySignature(secret, rawBody, headerSig);
    // EXOTEL DOES NOT SIGN STATUS CALLBACKS. There is no documented signature
    // header, so requiring an HMAC rejected every single callback with a 401 —
    // call lifecycle updates and post-call processing never ran, while the voice
    // path looked fine. The secret therefore travels in the callback URL we
    // register with Exotel (dial.service builds it), which is the only channel
    // Exotel gives us. The HMAC path is kept and still accepted, so a signed
    // caller (or a future Exotel that signs) keeps working unchanged.
    //
    // TRADE-OFF, ACCEPTED DELIBERATELY: a URL-borne secret can leak into access
    // logs and Referer headers in a way an HMAC header would not. It is still
    // strictly better than the alternatives here — unsetting the secret leaves
    // this PUBLIC endpoint able to fake call events for any call. Rotate
    // EXOTEL_WEBHOOK_SECRET if the URL is ever exposed.
    const tokenValid = this.urlTokenValid(secret, urlToken);
    if (secret && !signatureValid && !tokenValid) {
      // Say WHICH check failed — the old bare 401 gave nothing to debug with and
      // cost a long hunt to trace back to "Exotel never sends a signature".
      this.logger.warn(
        `Rejected Exotel webhook: signature=${headerSig ? "present-but-invalid" : "absent"}, ` +
          `urlToken=${urlToken ? "present-but-invalid" : "absent"}. Exotel does not sign callbacks — ` +
          "register the StatusCallback URL with ?token=<EXOTEL_WEBHOOK_SECRET>.",
      );
      throw new UnauthorizedException("Invalid Exotel webhook credentials");
    }

    const providerCallSid = String(payload.CallSid ?? payload.Sid ?? "");
    const eventType = String(payload.Event ?? payload.EventType ?? payload.CallStatus ?? "unknown");
    const mappedStatus = this.mapCallStatus(payload);
    const eventKey = this.buildEventKey(providerCallSid, eventType, mappedStatus, payload);

    // Single idempotency check: if we've already seen this exact event key, ignore.
    if (eventKey) {
      try {
        const existing = await this.webhookRepo.findByEventKey(eventKey);
        if (existing) {
          this.logger.log(`Duplicate webhook event=${eventKey}; ignoring`);
          return { status: "ignored" } as const;
        }
      } catch (err) {
        this.logger.warn(
          "Failed to check existing webhook event key",
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    let call: Call | undefined;
    if (providerCallSid) {
      try {
        call = await this.callRepo.findByProviderCallSid(providerCallSid);
        // If the call is already marked completed in our DB, a second completed webhook is a duplicate.
        if (mappedStatus === "completed" && call?.status === "completed") {
          this.logger.log(`Completed webhook already processed for sid=${providerCallSid}`);
          return { status: "ignored" } as const;
        }
      } catch (err) {
        this.logger.warn(
          "Failed to pre-correlate webhook to call",
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    // Persist webhook event (Rule 10: inbound webhook received)
    let eventRow: WebhookEvent | undefined;
    try {
      eventRow = await this.webhookRepo.create({
        provider: "exotel",
        eventType,
        eventKey,
        providerCallSid: providerCallSid || null,
        callId: call?.id ?? null,
        rawPayload: payload as unknown as Record<string, unknown>,
        // "was this callback authenticated", not "did an HMAC match". Exotel never
        // sends a signature, so keying this to the HMAC alone would stamp every
        // genuinely-verified event as unverified and make the audit column a lie.
        signatureValid: signatureValid || tokenValid,
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
        call = call ?? (await this.callRepo.findByProviderCallSid(providerCallSid));
        if (call) {
          if (mappedStatus) {
            const status = mappedStatus;
            const terminal = ["completed", "no_answer", "busy", "failed", "canceled"].includes(
              status,
            );
            const duration = Number(payload.ConversationDuration ?? NaN);
            await this.callRepo.updateByProviderCallSid(providerCallSid, {
              status,
              endedAt: terminal ? new Date() : undefined,
              answeredAt: status === "in_progress" ? new Date() : undefined,
              recordingUrl: payload.RecordingUrl,
              durationSeconds: Number.isFinite(duration) ? duration : undefined,
              hangupCause: payload.HangupCause,
            });
            if (call.targetId && terminal) {
              await this.targetRepo.updateDialStatus(call.targetId, this.mapTargetStatus(status));
            }
            if (status === "in_progress") {
              // Pre-build call state (campaign fetch + prompt) and warm filler
              // clips while the phone is still being answered, so the first
              // voice turn doesn't pay that latency.
              void this.callRuntime?.warmCall(call.id, call.locale ?? undefined);
            }
            if (terminal) {
              // Release in-memory conversation history for this call.
              this.callRuntime?.clearHistory(call.id);
              // Free the call slot the dial worker reserved. This is the only
              // release for a dial that never connects (no-answer / busy), since
              // the voicebot stream never starts. Idempotent with the gateway's.
              await this.slots?.release(call.id).catch(() => undefined);
            }
            if (status === "completed") {
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
              await this.callRepo.update(call.id, { locale: ivrResult.locale });
              const event: NewCallEvent = {
                callId: call.id,
                campaignId: call.campaignId ?? null,
                type: "escalation",
                severity: "info",
                message: `IVR selection: ${digits} -> ${ivrResult.locale}`,
                payload: { digits, mapped: ivrResult },
              };
              await this.eventRepo.create(event);
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

  buildEventKey(
    providerCallSid: string,
    eventType: string,
    mappedStatus: Call["status"] | undefined,
    payload: ExotelWebhookDto,
  ): string {
    const sid = providerCallSid || `payload:${this.payloadHash(payload)}`;
    const status = mappedStatus ?? "unknown";
    const digits = String(payload.Digits ?? "");
    return ["exotel", sid, eventType.toLowerCase(), status, digits].join(":");
  }

  private payloadHash(payload: ExotelWebhookDto): string {
    return crypto
      .createHash("sha256")
      .update(this.canonicalJson(payload))
      .digest("hex")
      .slice(0, 32);
  }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.canonicalJson(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  private mapCallStatus(payload: ExotelWebhookDto): Call["status"] | undefined {
    const statusMap: Record<string, Call["status"]> = {
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

    const raw = String(
      payload.CallStatus ?? payload.Status ?? payload.Event ?? payload.EventType ?? "",
    ).toLowerCase();
    return statusMap[raw];
  }

  private mapTargetStatus(mappedStatus: Call["status"]): CampaignTarget["dialStatus"] {
    if (mappedStatus === "completed") return "completed";
    if (mappedStatus === "no_answer") return "no_answer";
    if (mappedStatus === "busy") return "busy";
    return "failed";
  }
}
