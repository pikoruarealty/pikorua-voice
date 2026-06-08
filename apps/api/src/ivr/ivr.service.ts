import { Injectable } from "@nestjs/common";

export type IvrMapResult = { locale: string; provider?: "anthropic" | "google" };

@Injectable()
export class IvrService {
  // Map DTMF digit to locale and provider preference.
  mapDigitToLocale(digit?: string): IvrMapResult {
    switch (String(digit ?? "").trim()) {
      case "1":
        return { locale: "en-IN", provider: "anthropic" };
      case "2":
        return { locale: "hi-IN", provider: "google" };
      case "3":
        return { locale: "gu-IN", provider: "google" };
      default:
        // Default recommended = Hindi
        return { locale: "hi-IN", provider: "google" };
    }
  }
}
