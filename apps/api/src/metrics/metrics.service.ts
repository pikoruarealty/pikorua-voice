import { Injectable } from "@nestjs/common";
import { monitorEventLoopDelay } from "node:perf_hooks";

// Latency buckets (ms) sized for voice turns: sub-second buckets matter most.
const HISTOGRAM_BUCKETS = [100, 250, 500, 1000, 2000, 4000, 8000, 15000];

type Histogram = {
  buckets: number[]; // cumulative counts aligned with HISTOGRAM_BUCKETS
  sum: number;
  count: number;
};

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly startedAt = Date.now();
  // Event-loop lag: the API paces call audio on this loop, so sustained lag (p99
  // above ~30 ms) means it is starved of CPU and callers hear stutter. Reset on
  // every scrape, so each value covers the window since the previous scrape.
  private readonly loopDelay = (() => {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    return h;
  })();

  increment(name: string, labels: Record<string, string | number> = {}) {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  // Record a latency observation (ms) into a Prometheus-style histogram.
  observe(name: string, value: number, labels: Record<string, string | number> = {}) {
    if (!Number.isFinite(value)) return;
    const key = this.key(name, labels);
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = { buckets: new Array(HISTOGRAM_BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, hist);
    }
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
      if (value <= HISTOGRAM_BUCKETS[i]) hist.buckets[i] += 1;
    }
    hist.sum += value;
    hist.count += 1;
  }

  renderPrometheus() {
    const lines = [
      "# HELP pikorua_process_uptime_seconds Process uptime in seconds.",
      "# TYPE pikorua_process_uptime_seconds gauge",
      `pikorua_process_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`,
      "# HELP pikorua_event_loop_lag_ms Event-loop delay since the last scrape (ms).",
      "# TYPE pikorua_event_loop_lag_ms gauge",
    ];
    for (const [q, label] of [[50, "p50"], [99, "p99"], [100, "max"]] as const) {
      const ns = q === 100 ? this.loopDelay.max : this.loopDelay.percentile(q);
      lines.push(`pikorua_event_loop_lag_ms{quantile="${label}"} ${(ns / 1e6).toFixed(1)}`);
    }
    this.loopDelay.reset();

    for (const [key, value] of this.counters.entries()) {
      lines.push(`${key} ${value}`);
    }

    for (const [key, hist] of this.histograms.entries()) {
      const { name, labels } = this.splitKey(key);
      const withLe = (le: string) =>
        labels ? `${name}_bucket{${labels},le="${le}"}` : `${name}_bucket{le="${le}"}`;
      for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
        lines.push(`${withLe(String(HISTOGRAM_BUCKETS[i]))} ${hist.buckets[i]}`);
      }
      lines.push(`${withLe("+Inf")} ${hist.count}`);
      lines.push(`${labels ? `${name}_sum{${labels}}` : `${name}_sum`} ${hist.sum}`);
      lines.push(`${labels ? `${name}_count{${labels}}` : `${name}_count`} ${hist.count}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private splitKey(key: string): { name: string; labels: string | null } {
    const brace = key.indexOf("{");
    if (brace === -1) return { name: key, labels: null };
    return { name: key.slice(0, brace), labels: key.slice(brace + 1, -1) };
  }

  private key(name: string, labels: Record<string, string | number>) {
    const entries = Object.entries(labels);
    if (entries.length === 0) {
      return name;
    }
    const rendered = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`)
      .join(",");
    return `${name}{${rendered}}`;
  }
}
