import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { SERVICE } from "@pikorua/shared";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  // Render's free tier only offers "web service" hosting (no Background
  // Worker on the free plan). A bare HTTP listener on PORT lets this run as
  // a free web service — Render's health check just needs something to hit.
  // Switch back to createApplicationContext once on a paid Background Worker.
  const app = await NestFactory.create(WorkerModule, { logger: ["log", "warn", "error"] });
  app.enableShutdownHooks();

  const logger = new Logger(SERVICE.WORKER);
  const config = app.get(ConfigService);

  const redisUrl = String(config.get("REDIS_URL"));
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });

  try {
    await redis.connect();
    const pong = await redis.ping();
    logger.log(`Redis reachable at ${redisUrl} (${pong})`);
  } catch (err) {
    logger.error(
      `Cannot reach Redis at ${redisUrl}`,
      err instanceof Error ? err.stack : String(err),
    );
    await redis.quit().catch(() => undefined);
    await app.close();
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 10000);
  await app.listen(port, "0.0.0.0");
  logger.log(
    `${SERVICE.WORKER} ready — dial, postcall, and CRM-retry workers running (health on :${port})`,
  );

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal} — shutting down`);
    await redis.quit().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  // Bootstrap failed before the Nest logger is usable — fall back to console.
  console.error("Fatal: worker failed to start", err);
  process.exit(1);
});
