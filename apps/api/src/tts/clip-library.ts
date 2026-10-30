import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import fs from "node:fs";
import path from "node:path";

// Pre-recorded Maya lines (greetings, goodbyes, check-ins, acks, fillers, busy
// line) generated once in the live Sarvam voice and stored as 8 kHz mono 16-bit
// WAVs in assets/clips/. Playing one costs ₹0 and has ~0 ms time-to-first-audio.
//
// MATCHED BY EXACT TEXT. clips.json maps each file to the words it speaks; a line
// is served from a clip only when the code asks for that exact text in that
// language. If the wording in code changes, nothing matches and the line is
// synthesized live — a clip can never speak outdated words.
//
// TAKES ROTATE. Several takes of the same text (hi_greeting_1..5) are recorded
// separately, and consecutive calls never get the same take, so the opening
// doesn't sound like one frozen recording replayed on every call.

const SAMPLE_RATE = 8000;
const DEFAULT_DIR = path.resolve(__dirname, "../../../../assets/clips");

@Injectable()
export class ClipLibrary {
  private readonly logger = new Logger("ClipLibrary");
  private readonly takes = new Map<string, Buffer[]>();
  private readonly lastTake = new Map<string, number>();

  constructor(config: ConfigService) {
    this.load(String(config.get("CLIPS_DIR") ?? DEFAULT_DIR));
  }

  // "hi" | "en" | "gu" + the exact spoken text.
  private static key(lang: string, text: string): string {
    return `${lang}|${text.trim()}`;
  }

  private load(dir: string): void {
    let manifest: Record<string, string>;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, "clips.json"), "utf8"));
    } catch {
      this.logger.warn(`No clip library at ${dir} — every line is synthesized live`);
      return;
    }
    let count = 0;
    for (const [name, text] of Object.entries(manifest)) {
      const file = path.join(dir, `${name}.wav`);
      if (!fs.existsSync(file)) continue; // a take you deleted
      const pcm = readPcm8k(file);
      if (!pcm) {
        this.logger.warn(`Skipping clip ${name}: not 8 kHz mono 16-bit PCM WAV`);
        continue;
      }
      const key = ClipLibrary.key(name.split("_")[0], text);
      this.takes.set(key, [...(this.takes.get(key) ?? []), pcm]);
      count += 1;
    }
    this.logger.log(`Loaded ${count} clips (${this.takes.size} distinct lines) from ${dir}`);
  }

  // Number of distinct recorded lines (for the status dashboard).
  get lineCount(): number {
    return this.takes.size;
  }

  // Raw 8 kHz PCM for this line, or null to synthesize live. With several takes,
  // never returns the same take twice in a row.
  get(lang: string, text: string): Buffer | null {
    const key = ClipLibrary.key(lang, text);
    const takes = this.takes.get(key);
    if (!takes?.length) return null;
    let i = Math.floor(Math.random() * takes.length);
    if (takes.length > 1 && i === this.lastTake.get(key)) i = (i + 1) % takes.length;
    this.lastTake.set(key, i);
    return takes[i];
  }
}

// PCM payload of a canonical WAV, only if it is 8 kHz mono 16-bit (Exotel's wire
// format — anything else would play at the wrong speed or as noise).
function readPcm8k(file: string): Buffer | null {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
  // Walk the chunks: "fmt " carries the format, "data" the samples.
  let offset = 12;
  let ok = false;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      ok =
        buf.readUInt16LE(body) === 1 && // PCM
        buf.readUInt16LE(body + 2) === 1 && // mono
        buf.readUInt32LE(body + 4) === SAMPLE_RATE &&
        buf.readUInt16LE(body + 14) === 16;
    } else if (id === "data") {
      return ok ? buf.subarray(body, Math.min(buf.length, body + size)) : null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}
