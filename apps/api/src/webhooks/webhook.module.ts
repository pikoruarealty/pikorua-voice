import { Module } from "@nestjs/common";
import { WebhookController } from "./webhook.controller";
import { WebhookService } from "./webhook.service";
import {
  WebhookEventRepository,
  CallRepository,
  CallEventRepository,
  CampaignTargetRepository,
  type Database,
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
      useFactory: (db: Database) => new WebhookEventRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallRepository,
      useFactory: (db: Database) => new CallRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CallEventRepository,
      useFactory: (db: Database) => new CallEventRepository(db),
      inject: ["DATABASE"],
    },
    {
      provide: CampaignTargetRepository,
      useFactory: (db: Database) => new CampaignTargetRepository(db),
      inject: ["DATABASE"],
    },
    PostCallQueueService,
    IvrService,
    WebhookService,
  ],
})
export class WebhookModule {}
