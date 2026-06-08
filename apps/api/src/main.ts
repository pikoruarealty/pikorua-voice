import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { WsAdapter } from "@nestjs/platform-ws";
import { SERVICE } from "@pikorua/shared";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const logger = new Logger(SERVICE.API);

  app.useWebSocketAdapter(new WsAdapter(app));

  const config = app.get(ConfigService);
  const port = Number(config.get("API_PORT") ?? 4100);
  const nodeEnv = String(config.get("NODE_ENV") ?? "development");

  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  // Request-body validation uses Zod (Rule 8); a Zod validation pipe is added
  // alongside the first DTOs (campaign module / webhooks).

  await app.listen(port);
  logger.log(`Listening on http://localhost:${port}/api [${nodeEnv}]`);
}

bootstrap().catch((err) => {
  // Bootstrap failed before the Nest logger is usable — fall back to console.
  console.error("Fatal: API failed to start", err);
  process.exit(1);
});
