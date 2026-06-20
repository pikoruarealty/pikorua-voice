import { Controller, Get, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CampaignRepository, CampaignTargetRepository, CallRepository } from "@pikorua/db";
import { Public } from "../auth/public.decorator";

@Public()
@Controller("demo")
export class DemoController {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly targets: CampaignTargetRepository,
    private readonly calls: CallRepository,
    private readonly config: ConfigService,
  ) {}

  @Get("session")
  async createSession() {
    const locale = this.config.get<string>("CALL_LOCALE_DEFAULT") ?? "hi-IN";
    const token = this.config.get<string>("API_AUTH_TOKEN") ?? "";

    const campaign = await this.campaigns.create({
      name: "Browser Voice Demo",
      status: "draft",
      defaultLocale: locale,
      scriptRef: "default",
      notes: "Browser microphone demo session",
    });

    const target = await this.targets.create({
      campaignId: campaign.id,
      phone: "+910000000000",
      fullName: "Demo Caller",
      locale,
    });

    const call = await this.calls.create({
      campaignId: campaign.id,
      targetId: target.id,
      providerCallSid: `demo-${Date.now()}`,
      status: "in_progress",
      fromNumber: "+910000000000",
      toNumber: "+910000000001",
      locale,
    });

    return { callId: call.id, language: locale, token };
  }
}
