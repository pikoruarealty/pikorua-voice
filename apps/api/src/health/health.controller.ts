import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { HealthService } from "./health.service";

@Controller()
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("/health")
  async get() {
    const result = await this.health.check();
    if (result.status !== "ok") {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
