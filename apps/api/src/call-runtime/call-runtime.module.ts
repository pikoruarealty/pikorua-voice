import { Module } from "@nestjs/common";
import { DeepgramService } from "../stt/deepgram.service";
import { LlmService } from "../llm/llm.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { CallRuntimeService } from "./call-runtime.service";
import { CallTurnRepository } from "@pikorua/db";
import { CallRuntimeController } from "./call-runtime.controller";

@Module({
  providers: [
    DeepgramService,
    LlmService,
    ElevenlabsService,
    {
      provide: CallTurnRepository,
      useFactory: (db: any) => new CallTurnRepository(db),
      inject: ["DATABASE"],
    },
    CallRuntimeService,
  ],
  controllers: [CallRuntimeController],
  exports: [CallRuntimeService],
})
export class CallRuntimeModule {}
