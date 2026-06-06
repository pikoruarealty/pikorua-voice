import { Injectable } from "@nestjs/common";

export type IvrMapResult = { locale: string; provider?: "vapi" | "gemini" };

@Injectable()
export class IvrService {
  // Map DTMF digit to locale and provider preference per updated plan
  mapDigitToLocale(digit?: string): IvrMapResult {
    switch (String(digit ?? "").trim()) {
      case "1":
        return { locale: "en-IN", provider: "vapi" }; // English -> Vapi path
      case "2":
        return { locale: "hi-IN", provider: "gemini" }; // Hindi -> Gemini
      case "3":
        return { locale: "gu-IN", provider: "gemini" }; // Gujarati -> Gemini
      default:
        // Default recommended = Hindi
        return { locale: "hi-IN", provider: "gemini" };
    }
  }
}
