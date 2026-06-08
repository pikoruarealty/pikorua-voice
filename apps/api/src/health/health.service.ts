import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import type { Database } from "@pikorua/db";

type ProbeStatus = "ok" | { status: "error"; error: string };

@Injectable()
export class HealthService {
  private readonly logger = new Logger("HealthService");

  constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  async check() {
    const uptimeMs = process.uptime() * 1000;

    const database = await this.checkDatabase();
    const redis = await this.checkRedis();
    const status = database === "ok" && redis === "ok" ? "ok" : "error";

    return { status, details: { uptimeMs, database, redis } } as const;
  }

  private async checkDatabase(): Promise<ProbeStatus> {
    try {
      await this.db.execute("SELECT 1");
      return "ok";
    } catch (err) {
      this.logger.error(
        "Database health check failed",
        err instanceof Error ? err.stack : String(err),
      );
      return { status: "error", error: String(err) };
    }
  }

  private async checkRedis(): Promise<ProbeStatus> {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

    try {
      await redis.connect();
      await redis.ping();
      return "ok";
    } catch (err) {
      this.logger.error(
        "Redis health check failed",
        err instanceof Error ? err.stack : String(err),
      );
      return { status: "error", error: String(err) };
    } finally {
      await redis.quit().catch(() => undefined);
    }
  }
}
