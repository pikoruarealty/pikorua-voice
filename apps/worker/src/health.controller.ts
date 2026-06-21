import { Controller, Get } from "@nestjs/common";

// Render's free web-service tier requires an HTTP health check. This worker
// has no public API surface otherwise — BullMQ jobs run in the background.
@Controller("health")
export class HealthController {
  @Get()
  get() {
    return { status: "ok" };
  }
}
