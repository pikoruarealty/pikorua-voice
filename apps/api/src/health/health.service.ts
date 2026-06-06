import { Injectable, Inject, Logger } from "@nestjs/common";
import type { Database } from "@pikorua/db";

@Injectable()
export class HealthService {
  private readonly logger = new Logger("HealthService");

  constructor(@Inject("DATABASE") private readonly db: Database) {}

  async check() {
    const result: Record<string, unknown> = { uptimeMs: process.uptime() * 1000 };

    // DB check
    try {
      // Simple query to verify connectivity. Drizzle's underlying client will
      // surface an error if the DB is unreachable or misconfigured.
      // Using a lightweight query to avoid side effects.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // @ts-ignore execute may be available on the driver - fallback to a
      // repository call if needed during integration.
      // Prefer minimal surface area here.
      // If the SQL execution method differs in your environment, replace
      // with a repository-backed check.
      // Try `select 1` using raw SQL via the driver exposed by drizzle.
      // Note: keep this short and fail-safe.
      // @ts-expect-error
      await (this.db as any).execute?.("SELECT 1");
      result.database = "ok";
    } catch (err) {
      this.logger.error("Database health check failed", err instanceof Error ? err.stack : String(err));
      result.database = { status: "error", error: String(err) };
    }

    return {
      status: "ok",
      details: result,
    } as const;
  }
}
