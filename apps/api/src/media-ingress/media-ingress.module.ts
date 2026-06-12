import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MediaIngressGateway } from "./media-ingress.gateway";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";
import { DeepgramLiveService } from "../stt/deepgram-live.service";
import { CallRuntimeModule } from "../call-runtime/call-runtime.module";

@Module({
  imports: [ConfigModule, CallRuntimeModule],
  providers: [DeepgramRealtimeService, DeepgramLiveService, MediaIngressGateway],
})
export class MediaIngressModule {}
