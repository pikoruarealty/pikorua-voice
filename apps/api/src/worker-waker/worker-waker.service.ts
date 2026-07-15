import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

// Wakes the worker — a Render free-tier web service that spins down when idle.
//
// The worker drains two BullMQ queues (dial + postcall). A job sitting in Redis
// CANNOT wake a spun-down service; only an inbound HTTP request does. So whenever
// the API queues work for the worker — post-call after any inbound/outbound call,
// or an outbound dial — it pings the worker's URL so the instance cold-starts and
// picks the job up, instead of the job waiting for the next keep-alive tick (which
// is off by default). Fire-and-forget, throttled, and a no-op when the target URL
// is unset or local (dev, where the worker runs alongside the API).
@Injectable()
export class WorkerWaker {
  private readonly logger = new Logger("WorkerWaker");
  private lastPingAt = 0;
  private inFlight = false;
  // One request wakes the instance and resets its idle timer, so collapse a burst
  // (e.g. a 100-target campaign enqueue) down to a single ping.
  private readonly minIntervalMs = 20_000;

  constructor(private readonly config: ConfigService) {}

  private targetUrl(): string | null {
    const raw = String(this.config.get("WORKER_WAKE_URL") ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!raw) return null;
    // In dev the worker runs on the same host — no spin-down to wake.
    if (/localhost|127\.0\.0\.1/i.test(raw)) return null;
    return raw;
  }

  // Ping the worker so a spun-down instance starts. Fire-and-forget: never throws
  // into (or slows down) the caller's enqueue path.
  wake(reason: string): void {
    const url = this.targetUrl();
    if (!url) return;
    const now = Date.now();
    if (this.inFlight || now - this.lastPingAt < this.minIntervalMs) return;
    this.lastPingAt = now;
    this.inFlight = true;
    // A spun-down service holds the request through its ~30-60s cold start, so
    // allow a generous timeout; any non-2xx still means the instance is now up.
    axios
      .get(url, { timeout: 60_000, validateStatus: () => true })
      .then((res) => this.logger.log(`Woke worker (${reason}) → HTTP ${res.status}`))
      .catch((err) => this.logger.warn(`Worker wake ping failed (${reason}): ${String(err)}`))
      .finally(() => {
        this.inFlight = false;
      });
  }
}
