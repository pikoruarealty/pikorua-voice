import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MediaIngressGateway } from "./media-ingress.gateway";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";

@Module({
  imports: [ConfigModule],
  providers: [DeepgramRealtimeService, MediaIngressGateway],
})
export class MediaIngressModule {}
