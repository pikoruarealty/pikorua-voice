import { Injectable, Inject, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import type { Database } from "@pikorua/db";

type ProbeStatus = "ok" | { status: "error"; error: string };

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger("HealthService");
  private readonly redis: Redis;

  constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly config: ConfigService,
  ) {
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }

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
    try {
      if (this.redis.status === "end" || this.redis.status === "close") {
        await this.redis.connect();
      } else if (this.redis.status === "wait") {
        await this.redis.connect();
      }
      await this.redis.ping();
      return "ok";
    } catch (err) {
      this.logger.error(
        "Redis health check failed",
        err instanceof Error ? err.stack : String(err),
      );
      return { status: "error", error: String(err) };
    }
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
