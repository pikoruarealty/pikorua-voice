import { BadRequestException, Body, Controller, Headers, Logger, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { Public } from "../auth/public.decorator";
import { exotelWebhookSchema } from "./exotel.dto";
import { WebhookService } from "./webhook.service";

@Controller("webhooks")
@Public()
export class WebhookController {
  private readonly logger = new Logger("WebhookController");

  constructor(private readonly svc: WebhookService) {}

  @Post("/exotel")
  async exotel(
    @Req() req: Request,
    @Body() body: unknown,
    @Headers("x-exotel-signature") signature?: string,
  ) {
    // Obtain raw body for signature verification. If a raw body buffer was
    // captured by middleware it will be available as `req.rawBody`. Fall back
    // to a JSON string when not available.
    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody;
    const raw = Buffer.isBuffer(rawBody)
      ? rawBody.toString("utf8")
      : (rawBody ?? JSON.stringify(body ?? {}));

    const parsed = exotelWebhookSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`Invalid webhook payload: ${parsed.error.message}`);
      throw new BadRequestException("Invalid webhook payload");
    }

    // Exotel does NOT sign status callbacks (no documented signature header), so
    // the shared secret travels in the callback URL we registered instead — see
    // handleExotel. Accept it from either the query string or a bearer-style
    // header, whichever the caller used.
    const urlToken =
      typeof req.query?.token === "string"
        ? req.query.token
        : typeof req.query?.secret === "string"
          ? req.query.secret
          : null;

    return this.svc.handleExotel(raw, parsed.data, signature ?? null, urlToken);
  }
}
