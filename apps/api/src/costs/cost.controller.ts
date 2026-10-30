import { Controller, Get, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { CostService } from "./cost.service";

// @Public only skips the API-token guard: /api/costs sits behind the dashboard
// password (operatorPagesGuard), like the /costs page itself.
@Public()
@Controller("costs")
export class CostController {
  constructor(private readonly costs: CostService) {}

  @Get()
  get(@Query("days") days?: string) {
    return this.costs.report(Number(days ?? 30));
  }
}
