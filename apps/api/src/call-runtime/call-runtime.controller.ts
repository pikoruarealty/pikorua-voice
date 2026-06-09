import { BadRequestException, Body, Controller, Logger, Param, Post } from "@nestjs/common";
import { CallRuntimeService } from "./call-runtime.service";
import { turnPayloadSchema } from "./dto/turn.dto";
import { ZodError } from "zod";

@Controller("calls")
export class CallRuntimeController {
  private readonly logger = new Logger("CallRuntimeController");

  constructor(private readonly runtime: CallRuntimeService) {}

  @Post(":callId/turns")
  async handleTurn(@Param("callId") callId: string, @Body() body: unknown) {
    let parsed: ReturnType<typeof turnPayloadSchema.parse>;
    try {
      parsed = turnPayloadSchema.parse(body);
    } catch (err) {
      this.logger.warn("Invalid turn payload", err instanceof ZodError ? err.message : String(err));
      throw new BadRequestException("Invalid turn payload");
    }

    const buf = Buffer.from(parsed.audioBase64, "base64");
    const result = await this.runtime.handleTurn(callId, parsed.turnIndex, buf);
    return {
      audioBase64: result.audio.toString("base64"),
      transcript: result.transcript,
      reply: result.reply,
    };
  }
}
