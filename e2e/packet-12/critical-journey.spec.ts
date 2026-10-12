import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_SECURITY_HEADERS } from "../../scripts/release/build-artifact-checks.mjs";
import { datasetFingerprint, expectNoHorizontalOverflow, openDataBackup } from "../packet-10/support";
import { LOCALES, messagesFor, openTab, startPreparedProfile, stubWindowPrint, type Locale } from "../packet-11c/support";

/**
 * Packet 12B B2: the bilingual critical journey (design §6.1 minus the physical device; workflow groups 1, 2, 3, 5, 10 and 14) against
 * the production build served by `next start` (playwright.packet-12.config.ts; clean copy without `.env*`). Synthetic data only.
 * Flow: prepared profile → switch language and back → record a glucose reading → correct its time on the wheel (new revision) →
 * history → medicine schedule → Nearby food on the OneMap tile map (synthetic position; tiles served locally) → care preview with the
 * patient's own question → approve and print → reset to Welcome.
 * Each run asserts the visible outcome, the stored outcome (IndexedDB read) and absence of prohibited side effects: no request leaves
 * the local origin (the OneMap image host is allowed during the Nearby food step only, fulfilled locally), no /api/ai/* request (remote
 * AI is off in the candidate), no CSP violation and no page error.
 * Technical evidence only; not a human, device or owner review.
 */

const VALUE = { digits: ["8", "DECIMAL", "4"], text: "8.4" } as const;
const QUESTION: Readonly<Record<Locale, string>> = {
  "en-SG": "Can I bring my synthetic demo meter to the next visit?",
  "zh-SG": "下次复诊时，我可以带演示用的血糖仪吗？",
};
const VIEWPORTS = [
  { label: "390", viewport: { width: 390, height: 844 } },
  { label: "1280", viewport: { width: 1280, height: 800 } },
] as const;

/** The OneMap tile host (D4 CSP `img-src 'self' https://www.onemap.gov.sg`). Only the Nearby food step allows it, and only for images. */
const ONEMAP_ORIGIN = "https://www.onemap.gov.sg";
/** A local 1×1 PNG served for every OneMap tile: the map is exercised without contacting OneMap. */
const LOCAL_TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
/** A synthetic position in Toa Payoh, inside the HPB snapshot's coverage (no real person's location). */
const SYNTHETIC_POSITION = { latitude: 1.3401, longitude: 103.8569 } as const;

type Tripwire = { external: string[]; ai: string[]; violations: string[]; pageErrors: string[]; tiles: string[]; allowOneMapImages: boolean };

/**
 * Aborts and records any request to another origin or to /api/ai/*; records CSP violations and page errors. While
 * `allowOneMapImages` is set (the Nearby food step only), an IMAGE request to the OneMap origin is fulfilled locally with
 * LOCAL_TILE_PNG and recorded in `tiles`; anything else to OneMap is still an external request.
 */
async function installTripwire(page: Page, baseURL: string): Promise<Tripwire> {
  const origin = new URL(baseURL).origin;
  const wire: Tripwire = { external: [], ai: [], violations: [], pageErrors: [], tiles: [], allowOneMapImages: false };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (wire.allowOneMapImages && url.origin === ONEMAP_ORIGIN && route.request().resourceType() === "image") {
      wire.tiles.push(url.pathname);
      return route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, body: LOCAL_TILE_PNG });
    }
    if (url.protocol !== "data:" && url.protocol !== "blob:" && url.origin !== origin) {
      wire.external.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (url.pathname.startsWith("/api/ai/")) {
      wire.ai.push(url.pathname);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    const target = window as unknown as { __cspViolations?: string[] };
    target.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => target.__cspViolations!.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
  page.on("pageerror", (error) => wire.pageErrors.push(error.name));
  // Chromium also reports each violation on the console; this survives a document reload (the reset may reload).
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) wire.violations.push("console: Content Security Policy");
  });
  return wire;
}

/** CSP violations recorded in the current document so far (the console listener also records them across reloads). */
async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])]);
}

async function assertTripwire(page: Page, wire: Tripwire): Promise<void> {
  wire.violations.push(...(await cspViolations(page)));
  expect(wire.external, "requests to another origin").toEqual([]);
  expect(wire.ai, "/api/ai/* requests").toEqual([]);
  expect(wire.violations, "CSP violations").toEqual([]);
  expect(wire.pageErrors, "page errors").toEqual([]);
}

/** Every GLUCOSE_READING revision: record id, revision number, entered value and occurrence instant. Reads only. */
async function glucoseRevisions(page: Page): Promise<{ recordId: string; revisionNumber: number; entered: string; occurrence: string }[]> {
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
            resolve(
              rows.map((row) => {
                const revision = row.revision as { payload?: { measurement?: { enteredValue?: string } } };
                return { recordId: String(row.recordId), revisionNumber: Number(row.revisionNumber), entered: String(revision?.payload?.measurement?.enteredValue ?? ""), occurrence: String(row.occurrenceSortInstant ?? "") };
              }),
            );
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** Switches from the CURRENT locale `from` to `to`: the More tab is found by the label currently shown, not the target's. */
async function switchLanguage(page: Page, from: Locale, to: Locale): Promise<void> {
  const en = messagesFor("en-SG");
  const m = messagesFor(to);
  await openTab(page, messagesFor(from).shared.navMore);
  const name = m.settings[to === "en-SG" ? "english" : "chinese"];
  await page.getByRole("group", { name: new RegExp(`${en.settings.language}|${messagesFor("zh-SG").settings.language}`) }).getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name, pressed: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: m.more.title })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe(to);
}

test("serves the D4 security headers on the page and API routes (live response)", async ({ page, request, baseURL }) => {
  const response = await page.goto(`${baseURL}/`);
  const headers = response!.headers();
  for (const [key, value] of Object.entries(EXPECTED_SECURITY_HEADERS.page)) expect(headers[key], key).toBe(value);
  const api = await request.post(`${baseURL}/api/ai/task`, { data: {} });
  expect(api.headers()["cache-control"]).toContain("no-store");
  expect(api.headers()["content-security-policy"]).toBe(EXPECTED_SECURITY_HEADERS.page["content-security-policy"]);
});

for (const locale of LOCALES) {
  for (const { label, viewport } of VIEWPORTS) {
    test.describe(`critical journey ${locale} ${label}`, () => {
      test.use({ viewport });

      test(`prepared profile → language round trip → glucose record and time correction → history → schedule → nearby food map → care preview, print → reset (${locale}, ${label})`, async ({ page, baseURL }) => {
        const wire = await installTripwire(page, baseURL!);
        await stubWindowPrint(page);
        const other: Locale = locale === "en-SG" ? "zh-SG" : "en-SG";

        // 1. Prepared profile, then the language round trip (group 2), ending in the run's locale.
        await startPreparedProfile(page, baseURL!, "en-SG");
        await switchLanguage(page, "en-SG", other);
        await switchLanguage(page, other, "en-SG");
        if (locale !== "en-SG") await switchLanguage(page, "en-SG", locale);
        const m = messagesFor(locale);
        await openTab(page, m.shared.navToday);
        await expect(page.getByRole("button", { name: m.today.recordReading })).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // 2. Record a glucose reading from the keypad (group 3).
        const before = new Set((await glucoseRevisions(page)).map((r) => r.recordId));
        await page.getByRole("button", { name: m.today.recordReading }).click();
        await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
        await page.getByRole("radio", { name: m.glucose.contextBeforeBreakfast }).check();
        const keypad = page.getByRole("group", { name: m.glucose.keypadLabel });
        for (const key of VALUE.digits) await keypad.getByRole("button", { name: key === "DECIMAL" ? m.glucose.decimalPoint : key, exact: true }).click();
        await expectNoHorizontalOverflow(page);
        await page.getByRole("button", { name: m.glucose.saveAction }).click();
        await expect(page.getByText(m.glucose.saved)).toBeVisible();

        const created = (await glucoseRevisions(page)).filter((r) => !before.has(r.recordId));
        expect(created.map((r) => [r.revisionNumber, r.entered])).toEqual([[1, VALUE.text]]);
        const recordId = created[0]!.recordId;

        // 3. Correct its time on the wheel: yesterday, one hour later, keyboard-operated (new revision, history kept).
        await openTab(page, m.shared.navToday);
        await page.getByRole("button", { name: m.readingTime.editTime }).first().click();
        await expect(page.getByRole("heading", { level: 1, name: m.glucose.whenQuestion })).toBeVisible();
        await expect(page.getByText(VALUE.text, { exact: true }).first()).toBeVisible();
        await page.getByRole("radio", { name: m.readingTime.dayYesterday }).check();
        const hour = page.getByRole("listbox", { name: m.readingTime.hourLabel });
        await hour.focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByText(m.readingTime.sameAsCurrent)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await page.getByRole("button", { name: m.readingTime.saveOccurrence }).click();
        await expect(page.getByText(m.readingTime.saved)).toBeVisible();

        const revisions = (await glucoseRevisions(page)).filter((r) => r.recordId === recordId).sort((a, b) => a.revisionNumber - b.revisionNumber);
        expect(revisions.map((r) => [r.revisionNumber, r.entered])).toEqual([
          [1, VALUE.text],
          [2, VALUE.text],
        ]);
        // Moved to yesterday (± the one-hour wheel step, minute resolution): earlier by more than 12 h and less than 36 h.
        const shift = Date.parse(revisions[0]!.occurrence) - Date.parse(revisions[1]!.occurrence);
        expect(shift).toBeGreaterThan(12 * 60 * 60 * 1000);
        expect(shift).toBeLessThan(36 * 60 * 60 * 1000);

        // 4. Recorded history (group 3/6 surface).
        await openTab(page, m.shared.navHistory);
        await expect(page.getByRole("heading", { level: 1, name: m.history.title })).toBeVisible();
        await expect(page.getByText(m.history.unavailableTitle)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // 5. Medicine schedule: an absent log reads "not recorded", never missed (group 5, LRJ-003).
        await openTab(page, m.shared.navBooklet);
        await expect(page.getByRole("heading", { level: 1, name: m.schedule.title })).toBeVisible();
        await expect(page.getByText(m.schedule.notRecorded).first()).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // 5b. Nearby food with the OneMap tile map (D4 CSP img-src): a synthetic position, tiles fulfilled locally with a PNG; the
        //     OneMap host is allowed for images during this step only. Asserts tiles loaded and zero CSP violations.
        await page.context().grantPermissions(["geolocation"], { origin: new URL(baseURL!).origin });
        await page.context().setGeolocation(SYNTHETIC_POSITION);
        const violationsBefore = (await cspViolations(page)).length;
        wire.allowOneMapImages = true;
        await openTab(page, m.shared.navMore);
        await page.getByRole("button", { name: new RegExp(m.more.foodInformation) }).click();
        await expect(page.getByRole("heading", { level: 1, name: m.food.title })).toBeVisible();
        await page.getByRole("button", { name: m.food.useCurrentLocation }).click();
        await page.getByRole("button", { name: m.shared.continue }).click();
        const map = page.getByRole("region", { name: m.food.viewMap });
        await expect(map).toBeVisible();
        await expect(map.locator("img.leaflet-tile-loaded").first()).toBeVisible();
        await expect(page.getByText(m.food.mapTilesUnavailable)).toHaveCount(0);
        // Keep the image allowance open until tile requests settle (Leaflet may request more tiles while it zooms or pans): a quiet
        // window of 750 ms with no new tile request, polled for at most 15 s. Only then is the OneMap host blocked again.
        await expect
          .poll(
            async () => {
              const before = wire.tiles.length;
              await page.waitForTimeout(750);
              return wire.tiles.length === before;
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        wire.allowOneMapImages = false;
        expect(wire.tiles.length, "OneMap tiles served locally").toBeGreaterThan(0);
        expect(wire.tiles.every((path) => path.startsWith("/maps/tiles/Default/") || path.startsWith("/web-assets/images/logo/")), wire.tiles.join(",")).toBe(true);
        expect((await cspViolations(page)).slice(violationsBefore), "CSP violations during the Nearby food step").toEqual([]);
        expect(wire.external, "no other external request during the Nearby food step").toEqual([]);
        await expectNoHorizontalOverflow(page);

        // 6. Care preview with the patient's own question, approved and printed (group 10, LRJ-005).
        const question = QUESTION[locale];
        await openTab(page, m.shared.navToday);
        await page.getByRole("button", { name: m.today.prepareAppointment }).click();
        await page.getByRole("button", { name: m.carePreparation.addOwnQuestion }).click();
        const editor = page.getByRole("dialog");
        await editor.getByLabel(m.carePreparation.questionLabel).fill(question);
        await editor.getByRole("button", { name: m.shared.save }).click();
        await expect(editor).toHaveCount(0);
        const box = page.getByRole("checkbox", { name: question });
        if (!(await box.isChecked())) await box.check();
        await page.getByRole("button", { name: m.carePreparation.previewSummary }).click();
        await expect(page.getByRole("heading", { level: 1, name: m.careSummary.title })).toBeVisible();
        const article = page.locator("article.printable-care-summary");
        await expect(article).toContainText(question);
        // Owner demo override (owner decision 2026-10-12): an en-SG care preview is offered the AI action even outside the evaluated
        // classes; never zh-SG. This journey never accepts it, so nothing is sent.
        await expect(page.getByRole("button", { name: m.ai.careSummary.action })).toHaveCount(locale === "en-SG" ? 1 : 0);
        await expectNoHorizontalOverflow(page);
        await page.getByRole("button", { name: m.careSummary.approveAction }).click();
        await page.getByRole("button", { name: m.careSummary.printAction }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __c7PrintCalls?: number }).__c7PrintCalls ?? 0)).toBe(1);
        await page.emulateMedia({ media: "print" });
        expect(await article.innerText()).toContain(question);
        await page.emulateMedia({ media: null });

        // 7. Reset to a clean state: delete everything on this device → Welcome; nothing stored remains (group 14).
        //    The care summary preview has no tab bar: go back to More first (openTab steps back until the navigation shows).
        await openTab(page, m.shared.navMore);
        await openDataBackup(page, m.packet10.more.data);
        await page.getByRole("button", { name: m.packet10.hub.deleteAll }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.getByLabel(m.packet10.deletion.typeToConfirm).fill(m.packet10.deletion.deleteConfirmToken);
        await dialog.getByRole("button", { name: m.packet10.deletion.deleteAllAction }).click();
        const welcome = [messagesFor("en-SG").onboarding.welcomeTitle, messagesFor("zh-SG").onboarding.welcomeTitle];
        await expect(page.getByRole("heading", { level: 1, name: new RegExp(welcome.join("|")) })).toBeVisible();
        expect((await datasetFingerprint(page)).heads).toBe(0);
        expect(await page.evaluate(() => localStorage.getItem("jagaon:demo-onboarding:v1"))).toBeNull();
        await expectNoHorizontalOverflow(page);

        await assertTripwire(page, wire);
      });
    });
  }
}
