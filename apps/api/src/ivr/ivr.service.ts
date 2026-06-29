import { Injectable } from "@nestjs/common";

export type IvrMapResult = { locale: string; provider?: "openrouter" };

@Injectable()
export class IvrService {
  // Map DTMF digit to locale and provider preference.
  mapDigitToLocale(digit?: string): IvrMapResult {
    switch (String(digit ?? "").trim()) {
      case "1":
        return { locale: "en-IN", provider: "openrouter" };
      case "2":
        return { locale: "hi-IN", provider: "openrouter" };
      case "3":
        return { locale: "gu-IN", provider: "openrouter" };
      default:
        return { locale: "hi-IN", provider: "openrouter" };
    }
  }
}
