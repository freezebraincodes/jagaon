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
    // 13s.3 (extractor round 4): a health question (HEALTH_QUESTION), a reported amount (TAKEN: stored; SKIPPED: not stored).
    // CR-11 (owner decisions 2026-10-11): case 11, "60 mmol/L", now asks for an explicit number-and-unit confirmation.
    health: "Is a sugar of 15 dangerous?",
    outOfRange: "My sugar was 60 mmol",
    sixtyWords: "My sugar was sixty mmol",
    zero: "sugar zero mmol",
    sixtyNoUnit: "My sugar was sixty",
    mixedSixty: "My sugar was 60 mmol, I had chicken rice for lunch",
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
    sixtyWords: "血糖六十毫摩尔",
    zero: "血糖零毫摩尔",
    sixtyNoUnit: "血糖六十",
    mixedSixty: "血糖60毫摩尔，我午饭吃了鸡饭",
    amountTaken: "我打了十个单位的黑色的笔",
    amountSkipped: "我没有打十个单位的黑色的笔",
  },
} as const satisfies Record<Locale, Record<string, string>>;
export const DARK_PEN: Record<Locale, string> = { "en-SG": "dark pen", "zh-SG": "黑色的笔" };
/** The reported amount exactly as the extractor keeps it from SCRIPTS.amountTaken / amountSkipped (13s.3). */
export const REPORTED_AMOUNT: Record<Locale, string> = { "en-SG": "10 units", "zh-SG": "10 个单位" };

/**
 * Opens Tell JagaOn from Today with the harness "hearing" `say` (or a scripted start failure), accepts the disclosure. Owner decision
 * 2026-10-12 (optional passcodes): with `passcode: "none"` in the query the deployment requires no passcode, so the disclosure must show
 * no passcode field and Accept is enabled at once (consent → microphone); otherwise the passcode is entered first, as before.
 */
export async function startVoice(page: Page, m: AppMessages, query: Record<string, string>): Promise<void> {
  await page.goto(`${HARNESS_URL}/?${new URLSearchParams(query).toString()}`);
  const entry = page.getByRole("button", { name: m.voice.entry });
  await expect(entry).toBeEnabled();
  await entry.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(m.voice.disclosure.title);
  const accept = dialog.getByRole("button", { name: m.voice.disclosure.accept });
  if (query.passcode === "none") {
    await expect(dialog.getByLabel(m.aiAccess.passcodeLabel)).toHaveCount(0);
    await expect(accept).toBeEnabled();
  } else {
    await expect(accept).toBeDisabled();
    await dialog.getByLabel(m.aiAccess.passcodeLabel).fill(SYNTHETIC_PASSCODE);
  }
  await accept.click();
}

/** Speaks `say` through the harness fake and stops, with the given extra query (Owner decision 2026-10-12: e.g. `passcode: "none"`). */
export async function speakWith(page: Page, m: AppMessages, say: string, extra: Record<string, string>): Promise<void> {
  await startVoice(page, m, { say, ...extra });
  const stop = page.getByRole("button", { name: m.voice.state.stop });
  await expect(stop).toBeEnabled();
  await stop.click();
}

/** Speaks `say` through the harness fake and stops; resolves once the review (or an end state) is shown. */
export async function speak(page: Page, m: AppMessages, say: string): Promise<void> {
  await startVoice(page, m, { say });
  const stop = page.getByRole("button", { name: m.voice.state.stop });
  await expect(stop).toBeEnabled();
  await stop.click();
}

/** CR-11 record-count audit (the R-28 method): IndexedDB `jagaon` recordRevisions / recordHeads counted by record type (read-only). */
export type RecordCounts = Record<string, number>;
export async function recordCounts(page: Page): Promise<RecordCounts> {
  return page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const open = indexedDB.open("jagaon");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const out: Record<string, number> = {};
          const tx = db.transaction(["recordRevisions", "recordHeads"], "readonly");
          for (const store of ["recordRevisions", "recordHeads"]) {
            const request = tx.objectStore(store).getAll();
            request.onsuccess = () => {
              for (const row of request.result as Array<{ recordType: string }>) out[`${store}.${row.recordType}`] = (out[`${store}.${row.recordType}`] ?? 0) + 1;
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
        };
      }),
  );
}
/**
 * Derived records the background intelligence coordinator writes on its own schedule after the profile starts (never from a voice or
 * manual save); the audit compares patient records only.
 */
const DERIVED_RECORD_TYPES = ["LEARNED_KNOWLEDGE", "PATTERN_EVIDENCE_SNAPSHOT", "PATTERN_OBSERVATION"];
/** The changed patient-record counts between two audits (only non-zero differences; derived intelligence records excluded). */
export function countDelta(before: RecordCounts, after: RecordCounts): RecordCounts {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => !DERIVED_RECORD_TYPES.includes(key.split(".")[1]!))
      .map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)])
      .filter(([, value]) => value !== 0),
  );
}
