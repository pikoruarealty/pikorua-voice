import { Inject, Injectable, Logger } from "@nestjs/common";
import { AppointmentRepository } from "@pikorua/db";
import type { Appointment, NewAppointment } from "@pikorua/db";
import { formatIstWhen } from "@pikorua/shared";
import type { CreateAppointmentDto, UpdateAppointmentDto } from "./dto/appointment.dto";

// An authoritative appointment upgrades any provisional (auto) row for the same
// phone within this window of the given time, instead of creating a duplicate.
const UPGRADE_WINDOW_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class AppointmentService {
  private readonly logger = new Logger("AppointmentService");

  constructor(
    @Inject(AppointmentRepository) private readonly repo: AppointmentRepository,
  ) {}

  async get(id: string): Promise<Appointment | undefined> {
    return this.repo.findById(id);
  }

  // Authoritative create/upgrade. If a provisional (or prior) active appointment
  // for this phone sits near the requested time, upgrade it in place so the auto
  // path and the API converge on one row; otherwise insert a confirmed one.
  async create(dto: CreateAppointmentDto): Promise<Appointment> {
    const scheduledAt = new Date(dto.scheduledAt);
    const existing = await this.repo.findActiveNear(dto.phone, scheduledAt, UPGRADE_WINDOW_MS);

    const patch = {
      scheduledAt,
      source: "api",
      confirmed: true,
      status: "confirmed" as const,
      // A confirmed time change must let the reminders fire fresh for the new slot.
      reminderT24At: null,
      reminderT2At: null,
      locale: dto.locale ?? existing?.locale ?? null,
      fullName: dto.fullName ?? existing?.fullName ?? null,
      crmLeadId: dto.crmLeadId ?? existing?.crmLeadId ?? null,
      metadata: { source: "api", scheduledAtHuman: formatIstWhen(scheduledAt) },
    };

    if (existing) {
      const updated = await this.repo.update(existing.id, patch);
      this.logger.log(`Upgraded appointment ${existing.id} via API (${dto.phone})`);
      return updated ?? existing;
    }

    const row: NewAppointment = {
      callId: dto.callId ?? null,
      campaignId: dto.campaignId ?? null,
      crmLeadId: dto.crmLeadId ?? null,
      fullName: dto.fullName ?? null,
      phone: dto.phone,
      locale: dto.locale ?? null,
      scheduledAt,
      status: "confirmed",
      source: "api",
      confirmed: true,
      metadata: { source: "api", scheduledAtHuman: formatIstWhen(scheduledAt) },
    };
    const created = await this.repo.create(row);
    this.logger.log(`Created appointment ${created.id} via API (${dto.phone})`);
    return created;
  }

  // Reschedule / confirm / cancel / record outcome. A reschedule resets the
  // reminder flags so the T-24h/T-2h calls fire again for the new time.
  async update(id: string, dto: UpdateAppointmentDto): Promise<Appointment | undefined> {
    const patch: Partial<NewAppointment> = {};
    if (dto.status) patch.status = dto.status;
    if (dto.outcome != null) patch.outcome = dto.outcome;
    if (dto.scheduledAt) {
      const scheduledAt = new Date(dto.scheduledAt);
      patch.scheduledAt = scheduledAt;
      patch.confirmed = true;
      patch.reminderT24At = null;
      patch.reminderT2At = null;
      if (!dto.status) patch.status = "rescheduled";
      patch.metadata = { source: "api", scheduledAtHuman: formatIstWhen(scheduledAt) };
    }
    if (dto.status === "confirmed") patch.confirmed = true;
    return this.repo.update(id, patch);
  }
}
