import { Controller, Get } from "@nestjs/common";
import { HealthService } from "./health.service";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("/health")
  async get() {
    return this.health.check();
  }
}
