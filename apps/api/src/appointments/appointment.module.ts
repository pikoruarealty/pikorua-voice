import { Module } from "@nestjs/common";
import { AppointmentController } from "./appointment.controller";
import { AppointmentService } from "./appointment.service";
import { AppointmentRepository, type Database } from "@pikorua/db";

@Module({
  controllers: [AppointmentController],
  providers: [
    {
      provide: AppointmentRepository,
      useFactory: (db: Database) => new AppointmentRepository(db),
      inject: ["DATABASE"],
    },
    AppointmentService,
  ],
})
export class AppointmentModule {}
