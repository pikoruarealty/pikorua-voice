import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { SERVICE } from "@pikorua/shared";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
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

  logger.log(`${SERVICE.WORKER} ready — dial, postcall, and CRM-retry workers running`);

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
