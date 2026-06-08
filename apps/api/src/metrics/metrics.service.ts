import { Injectable } from "@nestjs/common";

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly startedAt = Date.now();

  increment(name: string, labels: Record<string, string | number> = {}) {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  renderPrometheus() {
    const lines = [
      "# HELP pikorua_process_uptime_seconds Process uptime in seconds.",
      "# TYPE pikorua_process_uptime_seconds gauge",
      `pikorua_process_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`,
    ];

    for (const [key, value] of this.counters.entries()) {
      lines.push(`${key} ${value}`);
    }
    return `${lines.join("\n")}\n`;
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
