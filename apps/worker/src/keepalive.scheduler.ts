import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Render's free web-service tier spins the worker down after ~15 min without
// inbound HTTP traffic; the next dial then pays a ~30s cold start. Pinging our
// own public /health every 13 min keeps inbound traffic flowing so the instance
// never idles out. Set WORKER_PUBLIC_URL to this service's own Render URL to
// enable it; leaving it unset (e.g. local dev) disables the self-ping cleanly.
const KEEPALIVE_INTERVAL_MS = 13 * 60_000; // 13 min < Render's ~15 min idle window
const PING_TIMEOUT_MS = 10_000;

@Injectable()
export class KeepAliveScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("KeepAliveScheduler");
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const base = String(this.config.get("WORKER_PUBLIC_URL") ?? "").trim().replace(/\/+$/, "");
    if (!base) {
      this.logger.warn("WORKER_PUBLIC_URL not set; keep-alive self-ping disabled");
      return;
    }
    if (/localhost|127\.0\.0\.1/.test(base)) {
      this.logger.log("WORKER_PUBLIC_URL is local; keep-alive self-ping disabled");
      return;
    }

    // Accept either the base URL or a full ".../health" URL — don't double it up.
    const url = /\/health$/i.test(base) ? base : `${base}/health`;
    this.timer = setInterval(() => void this.ping(url), KEEPALIVE_INTERVAL_MS);
    // Don't let the keep-alive timer hold the event loop open on shutdown.
    this.timer.unref();
    this.logger.log(
      `Keep-alive self-ping enabled → ${url} every ${KEEPALIVE_INTERVAL_MS / 60_000} min`,
    );
  }

  private async ping(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        this.logger.warn(`Keep-alive ping ${url} → HTTP ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(
        `Keep-alive ping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
