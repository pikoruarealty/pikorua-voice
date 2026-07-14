import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { AppointmentService } from "./appointment.service";
import { createAppointmentSchema, updateAppointmentSchema } from "./dto/appointment.dto";

// Authoritative site-visit appointments API (#2). The reminder/feedback
// schedulers fire off the rows created/updated here. Auth is enforced by the
// global ApiAuthGuard (Bearer / x-api-key), same as the campaigns endpoint.
@Controller("appointments")
export class AppointmentController {
  private readonly logger = new Logger("AppointmentController");

  constructor(private readonly service: AppointmentService) {}

  @Post()
  async create(@Body() body: unknown) {
    const parsed = createAppointmentSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`Invalid create appointment payload: ${parsed.error.message}`);
      throw new BadRequestException("Invalid appointment payload");
    }
    return this.service.create(parsed.data);
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const appt = await this.service.get(id);
    if (!appt) throw new NotFoundException("Appointment not found");
    return appt;
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateAppointmentSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`Invalid update appointment payload: ${parsed.error.message}`);
      throw new BadRequestException("Invalid appointment payload");
    }
    const updated = await this.service.update(id, parsed.data);
    if (!updated) throw new NotFoundException("Appointment not found");
    return updated;
  }
}
