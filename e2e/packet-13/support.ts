import { expect, type Page } from "@playwright/test";
import { VOICE_SCREEN_PENDING_COPY } from "@/components/jagaon/voice/voice-screen-copy";
import type { AppMessages } from "@/i18n/types";
import { LOCALES, messagesFor, openTab, startPreparedProfile, VIEWPORTS, expectNoHorizontalOverflow, type Locale } from "../packet-11c/support";

/**
 * Packet 13 voice browser evidence (TEST-ONLY; technical evidence, not owner approval; presentation human acceptance pending).
 * - 3321: the PRODUCTION build (real TRTC loader, real `/api/voice/usersig`, no voice environment → the availability probe answers
 *   `{ available: false }`): voice-off proof.
 * - 3322: the isolated harness (e2e/packet-13/harness): the real app with the scripted fake transcriber; synthetic speech only.
 * Production saving is connected (the owner's integration gate is lifted): a confirmed fact shows "Saved." No flag, no skipped case.
 */
export { LOCALES, messagesFor, openTab, startPreparedProfile, VIEWPORTS, expectNoHorizontalOverflow, type Locale };
export const PRODUCTION_URL = "http://localhost:3321";
export const HARNESS_URL = "http://localhost:3322";
export const SYNTHETIC_PASSCODE = "p13-synthetic-demo-pass";
export const pending = (locale: Locale) => VOICE_SCREEN_PENDING_COPY[locale];
export const savedText = (locale: Locale) => pending(locale).card.saved;

/** The two demo utterances and the safety set, per locale (synthetic speech). */
export const SCRIPTS = {
  "en-SG": {
    demo: "My sugar was 6.8 mmol, I had chicken rice for lunch and I injected my dark pen",
    darkPenAgain: "I injected my dark pen",
    greyPen: "I need to inject my grey pen",
    noUnit: "Sugar reading 9.2",
    negated: "My sugar was not 6.8 mmol",
    comparison: "My sugar was below 4 mmol",
    otherPerson: "my wife's sugar was 9.1 mmol",
    unsupported: "My sugar was 6.8 mmol, I felt dizzy",
    dose: "How many tablets should I take?",
    mixed: "sugar 15 mmol, how many units now",
    otherUnit: "Sugar reading 120 mg/dL",
    // 13s.3 (extractor round 4): a health question (HEALTH_QUESTION), an out-of-range spoken value, a reported amount (TAKEN: stored;
    // SKIPPED: not stored).
    health: "Is a sugar of 15 dangerous?",
    outOfRange: "My sugar was 60 mmol",
    amountTaken: "I injected 10 units of my dark pen",
    amountSkipped: "I skipped 10 units of my dark pen",
  },
  "zh-SG": {
    demo: "血糖六点八毫摩尔，我午饭吃了鸡饭，然后打了黑色的笔",
    darkPenAgain: "我打了黑色的笔",
    greyPen: "我需要打灰色的笔",
    noUnit: "血糖9.2",
    negated: "血糖不是六点八毫摩尔",
    comparison: "血糖低于四毫摩尔",
    otherPerson: "我妈妈的血糖是十二毫摩尔",
    unsupported: "血糖六点八毫摩尔，我昨天下午有点头晕",
    dose: "我应该吃几片药？",
    mixed: "血糖十五毫摩尔，胰岛素打几个单位",
    otherUnit: "血糖120mg",
    health: "血糖十五危险吗？",
    outOfRange: "血糖60毫摩尔",
    amountTaken: "我打了十个单位的黑色的笔",
    amountSkipped: "我没有打十个单位的黑色的笔",
  },
} as const satisfies Record<Locale, Record<string, string>>;
export const DARK_PEN: Record<Locale, string> = { "en-SG": "dark pen", "zh-SG": "黑色的笔" };
/** The reported amount exactly as the extractor keeps it from SCRIPTS.amountTaken / amountSkipped (13s.3). */
export const REPORTED_AMOUNT: Record<Locale, string> = { "en-SG": "10 units", "zh-SG": "10 个单位" };

/** Opens Tell JagaOn from Today with the harness "hearing" `say` (or a scripted start failure), accepts the disclosure. */
export async function startVoice(page: Page, m: AppMessages, query: Record<string, string>): Promise<void> {
  await page.goto(`${HARNESS_URL}/?${new URLSearchParams(query).toString()}`);
  const entry = page.getByRole("button", { name: m.voice.entry });
  await expect(entry).toBeEnabled();
  await entry.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(m.voice.disclosure.title);
  await dialog.getByLabel(m.aiAccess.passcodeLabel).fill(SYNTHETIC_PASSCODE);
  await dialog.getByRole("button", { name: m.voice.disclosure.accept }).click();
}

/** Speaks `say` through the harness fake and stops; resolves once the review (or an end state) is shown. */
export async function speak(page: Page, m: AppMessages, say: string): Promise<void> {
  await startVoice(page, m, { say });
  const stop = page.getByRole("button", { name: m.voice.state.stop });
  await expect(stop).toBeEnabled();
  await stop.click();
}
