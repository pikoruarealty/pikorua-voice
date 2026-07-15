import { Global, Module } from "@nestjs/common";
import { WorkerWaker } from "./worker-waker.service";

// Global so both queue producers (PostCallQueueService in CallRuntimeModule and
// WebhookModule, DialQueueService in CampaignModule) share one waker + throttle.
@Global()
@Module({
  providers: [WorkerWaker],
  exports: [WorkerWaker],
})
export class WorkerWakerModule {}
