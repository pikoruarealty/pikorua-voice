import { Controller, Get, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { StatusService } from "./status.service";

// @Public only skips the API-token guard: /api/status sits behind the dashboard
// password (operatorOnly middleware in main.ts), like the /status page itself.
@Public()
@Controller("status")
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  get(@Query("refresh") refresh?: string) {
    return this.status.status(refresh === "1");
  }
}
