/**
 * Mid-call language-switch hysteresis.
 * Run with: pnpm build && node --test tools/tests/language-switch.test.js
 *
 * WHY THIS EXISTS — observed on a real call. Deepgram mis-heard a Hindi utterance as
 * the Latin gibberish "La cucinattima bat corona?". The detector's ">=2 Latin words
 * means English" rule read that as English, and the session flipped persona, prompt
 * and voice on the spot — then flipped back to Hindi, then to Gujarati, three
 * switches in ninety seconds, none of them requested.
 *
 * The rule now: an EXPLICIT request switches immediately; a language merely INFERRED
 * from script must be seen twice in a row. One bad transcript can no longer move the
 * session.
 *
 * These tests drive the gateway's real exported helpers where possible and otherwise
 * reproduce the decision exactly as enqueueTurn applies it, so the sequence from the
 * real call is replayed rather than approximated.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

// The helpers are module-private, so lift them out of the compiled gateway. This
// keeps the test honest (it runs the shipped code) without exporting internals just
// for testing.
function loadDetectors() {
  const src = fs.readFileSync("apps/api/dist/call-runtime/exotel-voicebot.gateway.js", "utf8");
  const explicit = src.match(/function explicitLanguageRequest\([\s\S]*?\n\}/);
  const detect = src.match(/function detectSpokenLanguage\([\s\S]*?\n\}/);
  assert.ok(explicit && detect, "could not find the detectors in the compiled gateway");
  // eslint-disable-next-line no-new-func
  return new Function(`${explicit[0]}\n${detect[0]}\nreturn { explicitLanguageRequest, detectSpokenLanguage };`)();
}

// Mirrors the decision in enqueueTurn.
function makeSession(startLocale) {
  let locale = startLocale;
  let pending = null;
  const { explicitLanguageRequest, detectSpokenLanguage } = loadDetectors();
  const current = () =>
    locale.toLowerCase().startsWith("gu") ? "gu" : locale.toLowerCase().startsWith("en") ? "en" : "hi";
  return {
    get locale() { return locale; },
    switches: [],
    feed(utterance) {
      const explicit = explicitLanguageRequest(utterance);
      const inferred = detectSpokenLanguage(utterance);
      let lang = null;
      if (explicit) {
        lang = explicit;
        pending = null;
      } else if (inferred && inferred !== current()) {
        if (pending === inferred) { lang = inferred; pending = null; }
        else { pending = inferred; }
      } else {
        pending = null;
      }
      if (lang) {
        const target = lang === "gu" ? "gu-IN" : lang === "hi" ? "hi-IN" : "en-IN";
        if (target !== locale) { locale = target; this.switches.push(target); }
      }
      return locale;
    },
  };
}

test("one garbled Latin transcript no longer flips the session", () => {
  const s = makeSession("hi-IN");
  // The exact mis-transcription from the call.
  s.feed("La cucinattima bat corona?");
  assert.equal(s.locale, "hi-IN", "a single garbled utterance must not switch the language");
  assert.deepEqual(s.switches, []);
});

test("the real call's sequence produces no spurious switches", () => {
  const s = makeSession("hi-IN");
  for (const u of [
    "Hello.",
    "कौन बोल रहा है?",
    "La cucinattima bat corona?", // garbage -> would have switched to en before
    "Hello.",
    "कौन बोल रहे हो चाहा?",
    "Five BHK जो ही रहे हो चुका हूं.",
    "Madam, आपका budget में कोई चिंता ना थी हम तो.",
    "J M K कई range.",
  ]) {
    s.feed(u);
  }
  assert.equal(s.locale, "hi-IN", `session drifted to ${s.locale}`);
  assert.deepEqual(s.switches, [], `unexpected switches: ${s.switches.join(", ")}`);
});

test("a genuine sustained switch still happens, on the second utterance", () => {
  const s = makeSession("hi-IN");
  s.feed("I am looking for a five BHK");
  assert.equal(s.locale, "hi-IN", "first English utterance only arms the switch");
  s.feed("what is the possession timeline");
  assert.equal(s.locale, "en-IN", "second English utterance commits it");
});

test("an explicit request switches immediately, without corroboration", () => {
  const gu = makeSession("hi-IN");
  gu.feed("खिला तुमको गुजराती बोलना आता है?");
  assert.equal(gu.locale, "gu-IN", "an explicit Gujarati request must not wait");

  const en = makeSession("hi-IN");
  en.feed("can you speak english");
  assert.equal(en.locale, "en-IN", "an explicit English request must not wait");
});

test("an interrupted run of evidence lapses instead of accumulating", () => {
  const s = makeSession("hi-IN");
  // NB: these must not contain the word "english" — that is an explicit request and
  // bypasses the hysteresis entirely.
  s.feed("tell me about the project"); // arms en
  s.feed("हाँ जी बिल्कुल"); // back to Hindi -> the armed switch must lapse
  s.feed("what about the location"); // arms again, but only once
  assert.equal(s.locale, "hi-IN", "evidence must be consecutive, not cumulative");
});
