import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { WsAdapter } from "@nestjs/platform-ws";
import { SERVICE } from "@pikorua/shared";
import { json, urlencoded, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { AppModule } from "./app.module";
import { DEMO_HTML } from "./demo-ui";
import { MetricsService } from "./metrics/metrics.service";

type RawBodyRequest = Request & { rawBody?: Buffer };

async function bootstrap() {
  // Run DB migrations before NestJS boots so the schema is always current.
  const migrateScript = resolve(__dirname, "../../../packages/db/scripts/migrate.js");
  const migration = spawnSync(process.execPath, [migrateScript], {
    stdio: "inherit",
    env: process.env,
  });
  if (migration.status !== 0) {
    console.error("Migrations failed — aborting startup");
    process.exit(1);
  }

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
  // Render (and most PaaS) injects PORT; fall back to API_PORT for local dev.
  const port = Number(process.env.PORT ?? config.get("API_PORT") ?? 4100);
  const nodeEnv = String(config.get("NODE_ENV") ?? "development");

  // Serve demo UI at root — must be registered before setGlobalPrefix
  app.getHttpAdapter().get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(DEMO_HTML);
  });

  app.setGlobalPrefix("api");
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = String(req.headers["x-request-id"] ?? randomUUID());
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      // Use the matched route TEMPLATE (e.g. "/calls/:callId/turns"), not the
      // concrete path. req.path embeds dynamic ids (callId, sids) which would
      // make this an unbounded-cardinality counter — a metrics memory leak and a
      // Prometheus blowup. Unmatched requests collapse to a single label.
      const route = (req as Request & { route?: { path?: string } }).route?.path;
      metrics.increment("pikorua_http_requests_total", {
        method: req.method,
        route: route ? `${req.baseUrl ?? ""}${route}` : "unmatched",
        status: res.statusCode,
      });
    });
    next();
  });
  app.enableShutdownHooks();
  // Request-body validation uses Zod (Rule 8); a Zod validation pipe is added
  // alongside the first DTOs (campaign module / webhooks).

  await app.listen(port, "0.0.0.0");
  logger.log(`Listening on 0.0.0.0:${port}/api [${nodeEnv}]`);
}

// LAST-RESORT NET. Node terminates the process on an unhandled rejection (verified:
// a rejected promise from a timer exits rather than continuing). In this service that
// is never a contained failure — the API holds every live Exotel WebSocket, so one
// stray rejection anywhere hangs up on EVERY caller mid-sentence. A dropped call is
// far worse than a leaked error, so log it loudly and stay up.
//
// This is a net, not a licence: anything that lands here is a bug with a real
// stack trace attached, and belongs fixed at its source.
process.on("unhandledRejection", (reason) => {
  console.error(
    "Unhandled promise rejection (API stayed up; fix the source)",
    reason instanceof Error ? reason.stack : reason,
  );
});
// uncaughtException is deliberately NOT swallowed: after one, process state is
// untrustworthy, and Render restarts us cleanly.

bootstrap().catch((err) => {
  // Bootstrap failed before the Nest logger is usable — fall back to console.
  console.error("Fatal: API failed to start", err);
  process.exit(1);
});
