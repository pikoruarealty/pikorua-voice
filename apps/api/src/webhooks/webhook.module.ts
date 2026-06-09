import { Module } from "@nestjs/common";
import { WebhookController } from "./webhook.controller";
import { WebhookService } from "./webhook.service";
import {
  WebhookEventRepository,
  CallRepository,
  CallEventRepository,
  CampaignTargetRepository,
} from "@pikorua/db";
import { PostCallQueueService } from "../postcall/postcall.queue";
import { IvrService } from "../ivr/ivr.service";
import { CallRuntimeModule } from "../call-runtime/call-runtime.module";

@Module({
  imports: [CallRuntimeModule],
  controllers: [WebhookController],
  providers: [
    {
      provide: WebhookEventRepository,
      useFactory: (db: any) => new WebhookEventRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallRepository,
      useFactory: (db: any) => new CallRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallEventRepository,
      useFactory: (db: any) => new CallEventRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CampaignTargetRepository,
      useFactory: (db: any) => new CampaignTargetRepository(db),
      inject: ["DATABASE"],
    },
    PostCallQueueService,
    IvrService,
    WebhookService,
  ],
})
export class WebhookModule {}
