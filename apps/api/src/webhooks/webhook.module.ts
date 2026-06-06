import { Module } from "@nestjs/common";
import { WebhookController } from "./webhook.controller";
import { WebhookService } from "./webhook.service";
import { WebhookEventRepository, CallRepository, CallEventRepository } from "@pikorua/db";

@Module({
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
    WebhookService,
  ],
})
export class WebhookModule {}
