import { Global, Module } from "@nestjs/common";
import { AppointmentRepository, type Database } from "@pikorua/db";
import { WorkerWaker } from "./worker-waker.service";
import { WorkerAvailabilityScheduler } from "./worker-availability.scheduler";

// Global so both queue producers (PostCallQueueService in CallRuntimeModule and
// WebhookModule, DialQueueService in CampaignModule) and the Exotel gateway share
// one waker + throttle. AppointmentRepository is a module-local provider (NOT
// exported) used only by the availability scheduler.
@Global()
@Module({
  providers: [
    WorkerWaker,
    {
      provide: AppointmentRepository,
      useFactory: (db: Database) => new AppointmentRepository(db),
      inject: ["DATABASE"],
    },
    WorkerAvailabilityScheduler,
  ],
  exports: [WorkerWaker],
})
export class WorkerWakerModule {}
