import { and, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../client";
import { appointments } from "../schema";
import type { Appointment, NewAppointment } from "../schema";

type AppointmentStatus = (typeof appointments.status.enumValues)[number];

// Statuses that still warrant a reminder call (a cancelled visit does not).
const REMINDABLE: AppointmentStatus[] = ["scheduled", "confirmed", "rescheduled"];
// Feedback only targets visits we have positive signal on — NOT a bare "scheduled"
// provisional row (a guessed date that was never confirmed): asking "how was your
// visit?" for a visit that may never have happened is worse than staying silent.
const FEEDBACKABLE: AppointmentStatus[] = ["confirmed", "rescheduled", "completed", "no_show"];

export class AppointmentRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Appointment | undefined> {
    return this.db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  }

  async create(data: NewAppointment): Promise<Appointment> {
    const [row] = await this.db.insert(appointments).values(data).returning();
    if (!row) throw new Error("Insert returned no rows");
    return row;
  }

  async update(id: string, patch: Partial<NewAppointment>): Promise<Appointment | undefined> {
    const [row] = await this.db
      .update(appointments)
      .set(patch)
      .where(eq(appointments.id, id))
      .returning();
    return row;
  }

  // Atomically claim a reminder slot: set the timestamp only if still unset, and
  // report whether THIS caller won. Guarantees exactly one dial per window even
  // if two worker instances (or a tick straddling a restart) race the same row.
  async claimReminder(id: string, kind: "t24" | "t2", at: Date): Promise<boolean> {
    const col = kind === "t24" ? appointments.reminderT24At : appointments.reminderT2At;
    const rows = await this.db
      .update(appointments)
      .set(kind === "t24" ? { reminderT24At: at } : { reminderT2At: at })
      .where(and(eq(appointments.id, id), isNull(col)))
      .returning({ id: appointments.id });
    return rows.length > 0;
  }

  // Atomically claim the single post-visit feedback call (same race guarantee).
  async claimFeedback(id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(appointments)
      .set({ feedbackCallAt: at })
      .where(and(eq(appointments.id, id), isNull(appointments.feedbackCallAt)))
      .returning({ id: appointments.id });
    return rows.length > 0;
  }

  // Dedup guard for the auto path: an active visit for the same phone within
  // `windowMs` of `scheduledAt` is treated as the same booking, so a re-run of
  // post-call processing (or a second qualifying call) doesn't create a duplicate.
  async findActiveNear(
    phone: string,
    scheduledAt: Date,
    windowMs: number,
  ): Promise<Appointment | undefined> {
    const lo = new Date(scheduledAt.getTime() - windowMs);
    const hi = new Date(scheduledAt.getTime() + windowMs);
    return this.db.query.appointments.findFirst({
      where: and(
        eq(appointments.phone, phone),
        inArray(appointments.status, REMINDABLE),
        gte(appointments.scheduledAt, lo),
        lte(appointments.scheduledAt, hi),
      ),
    });
  }

  // Reminder candidates: a remindable visit within the next 24h that still needs
  // at least one of its two reminders. The precise T-24h/T-2h decision is made by
  // the scheduler (pure window math) so it stays unit-testable without a DB.
  async findReminderCandidates(now: Date, limit: number): Promise<Appointment[]> {
    const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return this.db
      .select()
      .from(appointments)
      .where(
        and(
          inArray(appointments.status, REMINDABLE),
          gt(appointments.scheduledAt, now),
          lte(appointments.scheduledAt, horizon),
          or(isNull(appointments.reminderT24At), isNull(appointments.reminderT2At)),
        ),
      )
      .orderBy(appointments.scheduledAt)
      .limit(limit);
  }

  // Feedback candidates: a visit whose time is at/behind `cutoff` (= now - delay)
  // that hasn't had its post-visit feedback call enqueued yet.
  async findFeedbackCandidates(cutoff: Date, limit: number): Promise<Appointment[]> {
    return this.db
      .select()
      .from(appointments)
      .where(
        and(
          inArray(appointments.status, FEEDBACKABLE),
          isNull(appointments.feedbackCallAt),
          lte(appointments.scheduledAt, cutoff),
        ),
      )
      .orderBy(appointments.scheduledAt)
      .limit(limit);
  }
}
