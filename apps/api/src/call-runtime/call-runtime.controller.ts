import { Controller, Post, Param, Body, Logger } from "@nestjs/common";
import { CallRuntimeService } from "./call-runtime.service";
import { turnPayloadSchema } from "./dto/turn.dto";

@Controller("api/calls")
export class CallRuntimeController {
  private readonly logger = new Logger("CallRuntimeController");

  constructor(private readonly runtime: CallRuntimeService) {}

  @Post(":callId/turns")
  async handleTurn(@Param("callId") callId: string, @Body() body: unknown) {
    const parsed = turnPayloadSchema.parse(body);
    const buf = Buffer.from(parsed.audioBase64, "base64");
    const result = await this.runtime.handleTurn(callId, parsed.turnIndex, buf);
    return { audioBase64: result.audio.toString("base64") };
  }
}
