import { Controller, Get } from "@nestjs/common";
import { SERVICE } from "@pikorua/shared";
import { Public } from "./auth/public.decorator";

// ─── Liveness ────────────────────────────────────────────────────────────────
// Minimal boot smoke test for the scaffold (GET /api). The full Health module —
// with PostgreSQL and Redis readiness probes — is introduced in Step 4.

@Controller()
@Public()
export class AppController {
  @Get()
  liveness() {
    return {
      status: "ok",
      service: SERVICE.API,
      timestamp: new Date().toISOString(),
    };
  }
}
