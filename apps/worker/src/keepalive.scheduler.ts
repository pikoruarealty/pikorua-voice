import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Render's free web-service tier spins the worker down after ~15 min without
// inbound HTTP traffic; the next dial then pays a ~30s cold start. Pinging our
// own public /health every 13 min keeps inbound traffic flowing so the instance
// never idles out.
//
// MANUAL ON/OFF: the self-ping is controlled by WORKER_KEEPALIVE_ENABLED and
// defaults to OFF. Set WORKER_KEEPALIVE_ENABLED=true (and WORKER_PUBLIC_URL to
// this service's own Render URL) to turn it on; set it back to false (or unset
// WORKER_PUBLIC_URL) to turn it off. It re-reads the flag on each (re)deploy.
const KEEPALIVE_INTERVAL_MS = 13 * 60_000; // 13 min < Render's ~15 min idle window
const PING_TIMEOUT_MS = 10_000;

@Injectable()
export class KeepAliveScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("KeepAliveScheduler");
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const enabled =
      String(this.config.get("WORKER_KEEPALIVE_ENABLED") ?? "false").trim().toLowerCase() ===
      "true";
    if (!enabled) {
      this.logger.log("Keep-alive self-ping OFF (set WORKER_KEEPALIVE_ENABLED=true to enable)");
      return;
    }

    let base = String(this.config.get("WORKER_PUBLIC_URL") ?? "").trim().replace(/\/+$/, "");
    if (!base) {
      this.logger.warn("WORKER_KEEPALIVE_ENABLED=true but WORKER_PUBLIC_URL unset; self-ping disabled");
      return;
    }
    // Tolerate a scheme-less value ("host/health") by defaulting to https.
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
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
      `Keep-alive self-ping ON → ${url} every ${KEEPALIVE_INTERVAL_MS / 60_000} min`,
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
