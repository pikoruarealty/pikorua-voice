import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { WsAdapter } from "@nestjs/platform-ws";
import { SERVICE } from "@pikorua/shared";
import { json, urlencoded, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { AppModule } from "./app.module";
import { MetricsService } from "./metrics/metrics.service";

type RawBodyRequest = Request & { rawBody?: Buffer };

async function bootstrap() {
  // Disable NestJS built-in body parser so voice turns can carry base64 WAV.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bodyParser: false,
  });
  const captureRawBody = (req: RawBodyRequest, _res: Response, buf: Buffer) => {
    req.rawBody = Buffer.from(buf);
  };
  app.use(json({ limit: "20mb", verify: captureRawBody }));
  app.use(urlencoded({ limit: "20mb", extended: true, verify: captureRawBody }));
  const logger = new Logger(SERVICE.API);

  app.useWebSocketAdapter(new WsAdapter(app));

  const config = app.get(ConfigService);
  const metrics = app.get(MetricsService);
  const port = Number(config.get("API_PORT") ?? 4100);
  const nodeEnv = String(config.get("NODE_ENV") ?? "development");

  app.setGlobalPrefix("api");
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = String(req.headers["x-request-id"] ?? randomUUID());
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      metrics.increment("pikorua_http_requests_total", {
        method: req.method,
        route: req.path,
        status: res.statusCode,
      });
    });
    next();
  });
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
