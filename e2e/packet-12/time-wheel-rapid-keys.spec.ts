import { expect, test, type Page } from "@playwright/test";
import { messagesFor, openTab, startPreparedProfile } from "../packet-11c/support";

/**
 * The manual glucose entry's time wheel in a real browser (production build, playwright.packet-12.config.ts; clean copy without
 * `.env*`; synthetic data only). Rapid keys on a column used to leave Keen Slider's earlier snap animation running, so seconds later
 * the wheel settled on, and emitted, an earlier key's value (8:00 pm turned into 8:00 am). Each case checks the time card right after
 * the keys and again well past the 500 ms snap, that the wheel's centre band shows the selected options, and that the saved record's
 * occurrence is the time the card showed.
 */

const m = messagesFor("en-SG");
const VALUE = ["5", "DECIMAL", "4"] as const;
/** Well past Keen Slider's 500 ms snap animation; the defect showed within about a second. */
const SETTLE_MS = 3000;

const card = (page: Page) => page.locator(".time-card-value").first();
const column = (page: Page, name: string) => page.getByRole("listbox", { name });
const selected = (page: Page, name: string) => column(page, name).getByRole("option", { selected: true });
const COLUMNS = [m.readingTime.hourLabel, m.readingTime.minuteLabel, m.readingTime.periodLabel];

/** The option row each column shows in its centre band, read from layout (not from aria-selected). */
async function centreBand(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="listbox"]')].map((list) => {
      const box = list.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      const hit = [...list.querySelectorAll('[role="option"]')].find((option) => {
        const r = option.getBoundingClientRect();
        return r.top <= mid && r.bottom >= mid;
      });
      return hit?.textContent ?? "?";
    }),
  );
}

async function expectWheelMatches(page: Page, hour: string, minute: string, period: string) {
  await expect(selected(page, m.readingTime.hourLabel)).toHaveText(hour);
  await expect(selected(page, m.readingTime.minuteLabel)).toHaveText(minute);
  await expect(selected(page, m.readingTime.periodLabel)).toHaveText(period);
  expect(await centreBand(page)).toEqual([hour, minute, period]);
}

/** Every GLUCOSE_READING revision's record id and occurrence instant. Reads only. */
async function glucoseOccurrences(page: Page): Promise<{ recordId: string; occurrence: string }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("jagaon");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const all = database.transaction("recordRevisions", "readonly").objectStore("recordRevisions").getAll();
          all.onsuccess = () => {
            const rows = (all.result as Array<Record<string, unknown>>).filter((row) => row.recordType === "GLUCOSE_READING");
            database.close();
            resolve(rows.map((row) => ({ recordId: String(row.recordId), occurrence: String(row.occurrenceSortInstant ?? "") })));
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** "Yesterday, 8:00 pm" for an instant, in Singapore time as the card shows it. */
function singaporeWallClock(instant: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()}` };
}

function singaporeYesterday(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function openEntryAtYesterday(page: Page, baseURL: string) {
  await startPreparedProfile(page, baseURL, "en-SG");
  await openTab(page, m.shared.navToday);
  await page.getByRole("button", { name: m.today.recordReading }).click();
  await page.getByRole("radio", { name: m.glucose.contextBeforeBreakfast }).check();
  const keypad = page.getByRole("group", { name: m.glucose.keypadLabel });
  for (const key of VALUE) await keypad.getByRole("button", { name: key === "DECIMAL" ? m.glucose.decimalPoint : key, exact: true }).click();
  await page.getByRole("button", { name: m.readingTime.editTime }).click();
  await page.getByRole("radio", { name: m.readingTime.dayYesterday }).check();
}

/** Saves, then returns the new record's occurrence as Singapore date and card-style time. */
async function saveAndReadOccurrence(page: Page, before: Set<string>) {
  await page.getByRole("button", { name: m.glucose.saveAction }).click();
  await expect(page.getByText(m.glucose.saved)).toBeVisible();
  const created = (await glucoseOccurrences(page)).filter((row) => !before.has(row.recordId));
  expect(created).toHaveLength(1);
  return singaporeWallClock(created[0]!.occurrence);
}

/** Presses keys on one column in quick succession, as the defect's evidence run did. */
async function press(page: Page, name: string, keys: readonly string[]) {
  const list = column(page, name);
  for (const key of keys) await list.press(key);
}

const RAPID = [
  { name: "pm -> am -> pm", start: "End", periodKeys: ["Home", "ArrowDown"], period: "pm" },
  { name: "am -> pm -> am", start: "Home", periodKeys: ["End", "ArrowUp"], period: "am" },
  { name: "pm -> am -> pm -> am -> pm", start: "End", periodKeys: ["Home", "End", "Home", "End"], period: "pm" },
] as const;

for (const width of [390, 1280]) {
  test.describe(`time wheel on the manual glucose entry @${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    for (const { name, start, periodKeys, period } of RAPID) {
      test(`rapid keys ${name} keep the card, the wheel and the saved time on the last key`, async ({ page, baseURL }) => {
        await openEntryAtYesterday(page, baseURL!);
        const before = new Set((await glucoseOccurrences(page)).map((row) => row.recordId));
        // A known starting period, at rest.
        await press(page, m.readingTime.periodLabel, [start]);
        await page.waitForTimeout(1000);
        // The defect's evidence sequence: Home then ArrowDowns on the hour, Home on the minute, then the period keys.
        await press(page, m.readingTime.hourLabel, ["Home", ...Array<string>(7).fill("ArrowDown")]);
        await press(page, m.readingTime.minuteLabel, ["Home"]);
        await press(page, m.readingTime.periodLabel, periodKeys);
        const expected = `Yesterday, 8:00 ${period}`;
        await expect(card(page)).toHaveText(expected);
        await page.waitForTimeout(SETTLE_MS);
        await expect(card(page)).toHaveText(expected);
        await expectWheelMatches(page, "8", "00", period === "am" ? m.readingTime.am : m.readingTime.pm);
        const saved = await saveAndReadOccurrence(page, before);
        expect(saved).toEqual({ date: singaporeYesterday(), time: `8:00 ${period}` });
      });
    }

    test("rapid keys on the hour and minute columns settle on the last key", async ({ page, baseURL }) => {
      await openEntryAtYesterday(page, baseURL!);
      const before = new Set((await glucoseOccurrences(page)).map((row) => row.recordId));
      await press(page, m.readingTime.periodLabel, ["Home"]);
      await press(page, m.readingTime.hourLabel, ["End"]);
      await press(page, m.readingTime.minuteLabel, ["Home"]);
      await page.waitForTimeout(1000);
      await expect(card(page)).toHaveText("Yesterday, 12:00 am");
      // Away and straight back on each column: the start value must win, not the intermediate one.
      await press(page, m.readingTime.hourLabel, ["Home", "ArrowUp"]);
      await press(page, m.readingTime.minuteLabel, ["End", "ArrowDown", "ArrowUp", "ArrowDown"]);
      await expect(card(page)).toHaveText("Yesterday, 12:00 am");
      await page.waitForTimeout(SETTLE_MS);
      await expect(card(page)).toHaveText("Yesterday, 12:00 am");
      await expectWheelMatches(page, "12", "00", m.readingTime.am);
      expect(await saveAndReadOccurrence(page, before)).toEqual({ date: singaporeYesterday(), time: "12:00 am" });
    });

    test("slow keys and the mouse wheel still choose the time", async ({ page, baseURL }) => {
      await openEntryAtYesterday(page, baseURL!);
      const before = new Set((await glucoseOccurrences(page)).map((row) => row.recordId));
      for (const [name, keys] of [
        [m.readingTime.periodLabel, ["Home"]],
        [m.readingTime.hourLabel, ["Home", "ArrowDown", "ArrowDown"]],
        [m.readingTime.minuteLabel, ["Home", "ArrowDown"]],
      ] as const) {
        for (const key of keys) {
          await column(page, name).press(key);
          await page.waitForTimeout(700);
        }
      }
      await expect(card(page)).toHaveText("Yesterday, 3:01 am");
      // One mouse-wheel notch down on the minute column moves it on by at least one row.
      const box = (await column(page, m.readingTime.minuteLabel).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, box.height / 3);
      await expect(card(page)).not.toHaveText("Yesterday, 3:01 am");
      await page.waitForTimeout(SETTLE_MS);
      const minute = (await selected(page, m.readingTime.minuteLabel).textContent())!;
      expect(Number(minute)).toBeGreaterThan(1);
      await expect(card(page)).toHaveText(`Yesterday, 3:${minute} am`);
      await expectWheelMatches(page, "3", minute, m.readingTime.am);
      expect(await saveAndReadOccurrence(page, before)).toEqual({ date: singaporeYesterday(), time: `3:${minute} am` });
    });
  });
}
