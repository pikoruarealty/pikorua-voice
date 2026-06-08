import { Injectable, Inject, Logger } from "@nestjs/common";
import type { Database } from "@pikorua/db";

@Injectable()
export class HealthService {
  private readonly logger = new Logger("HealthService");

  constructor(@Inject("DATABASE") private readonly db: Database) {}

  async check() {
    const uptimeMs = process.uptime() * 1000;

    let database: "ok" | { status: "error"; error: string } = "ok";
    try {
      await this.db.execute("SELECT 1");
    } catch (err) {
      this.logger.error(
        "Database health check failed",
        err instanceof Error ? err.stack : String(err),
      );
      database = { status: "error", error: String(err) };
    }

    return { status: "ok", details: { uptimeMs, database } } as const;
  }
}
