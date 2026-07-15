import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppointmentRepository } from "@pikorua/db";
import { WorkerWaker } from "./worker-waker.service";

// The IST hour (0-23) of an instant. Pure — unit-tested.
export function istHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return hh % 24; // some platforms render midnight as "24"
}

// True if the instant is within [startHour, endHour) in IST (the business-hours
// keep-alive window). Handles a normal window (10..18) only; start < end expected.
export function inKeepaliveWindowIst(date: Date, startHour: number, endHour: number): boolean {
  const h = istHour(date);
  return h >= startHour && h < endHour;
}

// Keeps the free-tier worker available for TIME-DRIVEN appointment work, from the
// always-on API. Two behaviours per tick:
//   1. Wake-ahead — if any reminder/feedback is due to fire within the next few
//      minutes, ping the worker now so its 60s scheduler tick catches the window
//      (covers reminders at ANY hour, e.g. a 9 AM T-2h or a 9 PM feedback).
//   2. Business-hours keep-alive — during [start,end) IST, ping ~every 12 min so
//      the worker stays warm all day (also makes daytime dials/post-call instant).
// Idle unless WORKER_WAKE_URL is set. Call-driven wakes are handled separately by
// WorkerWaker at the enqueue sites.
@Injectable()
export class WorkerAvailabilityScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("WorkerAvailabilityScheduler");
  private timer: NodeJS.Timeout | null = null;
  private lastKeepAliveAt = 0;

  // Tick frequently for precise wake-ahead; keep-alive still only pings every
  // KEEPALIVE_INTERVAL_MS. 12 min + a 2 min tick keeps the max gap < Render's
  // ~15 min idle-sleep threshold.
  private static readonly TICK_MS = 2 * 60 * 1000;
  private static readonly KEEPALIVE_INTERVAL_MS = 12 * 60 * 1000;
  private static readonly WAKE_AHEAD_LOOKAHEAD_MS = 8 * 60 * 1000;
  private static readonly DEFAULT_FEEDBACK_DELAY_MS = 3 * 60 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly waker: WorkerWaker,
    @Inject(AppointmentRepository) private readonly appointmentRepo: AppointmentRepository,
  ) {}

  private hourEnv(key: string, fallback: number): number {
    const n = Number(this.config.get(key));
    return Number.isInteger(n) && n >= 0 && n <= 24 ? n : fallback;
  }

  private feedbackDelayMs(): number {
    const v = Number(this.config.get("APPOINTMENT_FEEDBACK_DELAY_MS"));
    return Number.isFinite(v) && v >= 0 ? v : WorkerAvailabilityScheduler.DEFAULT_FEEDBACK_DELAY_MS;
  }

  onModuleInit() {
    if (!this.waker.isConfigured()) {
      this.logger.log("WORKER_WAKE_URL not set — worker availability scheduler idle");
      return;
    }
    this.timer = setInterval(
      () => void this.tick(),
      WorkerAvailabilityScheduler.TICK_MS,
    );
    this.timer.unref();
    void this.tick();
    this.logger.log(
      `Worker availability scheduler started (keep-alive ${this.hourEnv(
        "WORKER_KEEPALIVE_START_HOUR_IST",
        10,
      )}-${this.hourEnv("WORKER_KEEPALIVE_END_HOUR_IST", 18)} IST)`,
    );
  }

  async tick(): Promise<void> {
    const now = new Date();

    // 1. Wake-ahead: any reminder/feedback firing soon → wake the worker now.
    try {
      const imminent = await this.appointmentRepo.countImminentReminders(
        now,
        WorkerAvailabilityScheduler.WAKE_AHEAD_LOOKAHEAD_MS,
        this.feedbackDelayMs(),
      );
      if (imminent > 0) this.waker.wake("reminder-ahead");
    } catch (err) {
      this.logger.warn(`wake-ahead check failed: ${String(err)}`);
    }

    // 2. Business-hours keep-alive: keep the worker warm through the day.
    const start = this.hourEnv("WORKER_KEEPALIVE_START_HOUR_IST", 10);
    const end = this.hourEnv("WORKER_KEEPALIVE_END_HOUR_IST", 18);
    if (
      end > start &&
      inKeepaliveWindowIst(now, start, end) &&
      Date.now() - this.lastKeepAliveAt >= WorkerAvailabilityScheduler.KEEPALIVE_INTERVAL_MS
    ) {
      this.lastKeepAliveAt = Date.now();
      this.waker.wake("keep-alive");
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
