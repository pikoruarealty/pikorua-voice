import { Controller, Post, Body, Headers, Req, Logger } from "@nestjs/common";
import { Request } from "express";
import { exotelWebhookSchema } from "./exotel.dto";
import { WebhookService } from "./webhook.service";

@Controller("api/webhooks")
export class WebhookController {
  private readonly logger = new Logger("WebhookController");

  constructor(private readonly svc: WebhookService) {}

  @Post("/exotel")
  async exotel(@Req() req: Request, @Body() body: unknown, @Headers("x-exotel-signature") signature?: string) {
    // Obtain raw body for signature verification. If a raw body buffer was
    // captured by middleware it will be available as `req.rawBody`. Fall back
    // to a JSON string when not available.
    const raw = (req as any).rawBody ?? JSON.stringify(body ?? {});

    try {
      const parsed = exotelWebhookSchema.parse(body);
      return await this.svc.handleExotel(String(raw), parsed as any, signature ?? null);
    } catch (err) {
      this.logger.warn("Invalid webhook payload", err instanceof Error ? err.stack : String(err));
      throw err;
    }
  }
}
