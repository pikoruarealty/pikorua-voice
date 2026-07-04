import { Module } from "@nestjs/common";
import { DeepgramService } from "../stt/deepgram.service";
import { DeepgramLiveService } from "../stt/deepgram-live.service";
import { DemoVoiceGateway } from "./demo-voice.gateway";
import { ExotelVoicebotGateway } from "./exotel-voicebot.gateway";
import { LlmService } from "../llm/llm.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { CallRuntimeService } from "./call-runtime.service";
import {
  CallTurnRepository,
  CallRepository,
  CampaignRepository,
  CampaignTargetRepository,
  type Database,
} from "@pikorua/db";
import { CallRuntimeController } from "./call-runtime.controller";
import { GuardrailService } from "../llm/guardrail.service";
import { IvrService } from "../ivr/ivr.service";

@Module({
  providers: [
    DeepgramService,
    DeepgramLiveService,
    DemoVoiceGateway,
    ExotelVoicebotGateway,
    LlmService,
    ElevenlabsService,
    GuardrailService,
    {
      provide: CallTurnRepository,
      useFactory: (db: Database) => new CallTurnRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallRepository,
      useFactory: (db: Database) => new CallRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CampaignRepository,
      useFactory: (db: Database) => new CampaignRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CampaignTargetRepository,
      useFactory: (db: Database) => new CampaignTargetRepository(db),
      inject: ["DATABASE"],
    },
    IvrService,
    CallRuntimeService,
  ],
  controllers: [CallRuntimeController],
  exports: [CallRuntimeService],
})
export class CallRuntimeModule {}
