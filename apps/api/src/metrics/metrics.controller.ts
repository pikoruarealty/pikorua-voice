import { Controller, Get, Header } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  // Prometheus scrapers can't send bearer tokens — expose without auth.
  // The endpoint only exposes aggregate counters/histograms, no PII.
  @Public()
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  get() {
    return this.metrics.renderPrometheus();
  }
}
