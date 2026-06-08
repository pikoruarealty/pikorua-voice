import { BadRequestException, Body, Controller, Logger, Param, Post } from "@nestjs/common";
import { CallRuntimeService } from "./call-runtime.service";
import { turnPayloadSchema } from "./dto/turn.dto";

@Controller("calls")
export class CallRuntimeController {
  private readonly logger = new Logger("CallRuntimeController");

  constructor(private readonly runtime: CallRuntimeService) {}

  @Post(":callId/turns")
  async handleTurn(@Param("callId") callId: string, @Body() body: unknown) {
    try {
      const parsed = turnPayloadSchema.parse(body);
      const buf = Buffer.from(parsed.audioBase64, "base64");
      const result = await this.runtime.handleTurn(callId, parsed.turnIndex, buf);
      return { audioBase64: result.audio.toString("base64") };
    } catch (err) {
      this.logger.warn(
        "Invalid turn payload or runtime failure",
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException("Invalid turn payload");
    }
  }
}
