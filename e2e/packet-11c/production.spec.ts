import { expect, test } from "@playwright/test";
import {
  captureState,
  evidencePath,
  expectNoHorizontalOverflow,
  installFocusProbe,
  LOCALES,
  messagesFor,
  openCarePreview,
  openHistory,
  openSettings,
  planStates,
  PRODUCTION_URL,
  recordTestResult,
  shellTripwire,
  startPreparedProfile,
  stubWindowPrint,
  VIEWPORTS,
  type EvidenceContext,
  type ViewportKey,
} from "./support";

/**
 * Packet 11C C7, target 1: the PRODUCTION build as is (shipped manifest: every task DETERMINISTIC_ONLY; every request class PENDING).
 * A tripwire fails the test if /api/ai/* is ever requested. Synthetic data only. Technical evidence, not owner approval.
 */

test.afterEach(async ({}, testInfo) => recordTestResult(testInfo));

/**
 * C7 finding (pre-existing, not introduced by Packet 11C; reported, not fixed here): on a first run, the language chosen on Welcome is
 * reverted to English when the newly created dataset finishes opening after the prepared setup completed (JagaOnApp sets the runtime's
 * stored locale unless `onboardingLocaleRef` is set, and finishing setup never sets it). Expected to FAIL until fixed; when it starts
 * passing, Playwright reports it, and `test.fail` must be removed.
 */
test.describe("C7 finding: Welcome language choice on a first run", () => {
  test.use({ viewport: VIEWPORTS.mobile.viewport });
  test("zh-SG chosen on Welcome stays zh-SG after the new dataset opens", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "documented once, in Chromium");
    test.fail(true, "pre-existing defect: the Welcome language choice is reverted to English when the dataset finishes opening");
    const zh = messagesFor("zh-SG");
    await page.goto(`${PRODUCTION_URL}/`);
    await page.getByRole("radio", { name: "简体中文" }).check();
    await page.getByRole("button", { name: zh.onboarding.usePrepared }).click();
    await expect(page.getByRole("button", { name: zh.today.recordReading })).toBeVisible();
    // The dataset is open once the More screen's setting is enabled; the app must still be in zh-SG then.
    await page.getByRole("navigation").getByRole("button").last().click();
    await expect(page.getByRole("checkbox")).toBeEnabled();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(zh.more.title, { timeout: 5_000 });
  });
});

for (const viewportKey of Object.keys(VIEWPORTS) as ViewportKey[]) {
  const viewport = VIEWPORTS[viewportKey];
  for (const locale of LOCALES) {
    test.describe(`production ${locale} ${viewport.label}`, () => {
      test.use({ viewport: viewport.viewport, deviceScaleFactor: viewport.deviceScaleFactor });
      const smoke = viewportKey === "mobile" ? " @smoke" : "";

      test(`deterministic only: no disclosure, passcode or care AI action; no AI marking; private-mode setting present (${locale}, ${viewport.label})${smoke}`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "production", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, ["history-deterministic", "settings-private-toggle", "care-preview-no-ai-action", "care-print-no-marking"]);
        const tripwire = await shellTripwire(page);
        await installFocusProbe(page);
        await stubWindowPrint(page);
        const m = await startPreparedProfile(page, PRODUCTION_URL, locale);

        // History: the explicit action explains deterministically at once (no dialog, no passcode field, no AI tags).
        const action = await openHistory(page, m);
        await action.focus();
        await page.keyboard.press("Enter");
        const panel = page.getByRole("region", { name: m.history.explanation.title });
        await expect(panel.getByRole("status")).not.toBeEmpty();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByText(m.aiAccess.passcodeLabel)).toHaveCount(0);
        await expect(panel.getByText(m.ai.demoTag)).toHaveCount(0);
        await expect(panel.getByText(m.ai.resultCheck)).toHaveCount(0);
        await expect(panel.getByRole("group")).toHaveCount(0);
        await expect(panel.getByText(m.ai.remoteNotAccepted)).toHaveCount(0);
        await expect(action).toHaveAttribute("aria-expanded", "true");
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "history-deterministic", ["no dialog", "no passcode field", "role=status headline present", "no ai.demoTag / ai.resultCheck / AI group", "no horizontal overflow", "tripwire: no /api/ai/* request"], panel);

        // More/Settings: the "Keep wording on this device" setting (C2) is present and operable by keyboard.
        await openSettings(page, m);
        const keep = page.getByRole("checkbox", { name: m.aiWording.keepOnDeviceLabel });
        await expect(keep).toBeEnabled();
        await expect(keep).not.toBeChecked();
        await expect(page.getByText(m.aiWording.keepOnDeviceBody)).toBeVisible();
        await keep.focus();
        await page.keyboard.press("Space");
        await expect(keep).toBeChecked();
        await page.keyboard.press("Space");
        await expect(keep).not.toBeChecked();
        await expectNoHorizontalOverflow(page);
        await keep.scrollIntoViewIfNeeded();
        await captureState(page, testInfo, context, "settings-private-toggle", ["checkbox present with its label and description", "toggled on and off with Space", "no horizontal overflow"], page.getByRole("region", { name: m.more.settingsHeading }));

        // Care: a deterministic preview has no AI action; the printed artifact carries no AI marking.
        const article = await openCarePreview(page, m);
        await expect(page.getByRole("button", { name: m.ai.careSummary.action })).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(article).not.toContainText(m.ai.demoTag);
        await expect(article).not.toContainText(m.ai.resultCheck);
        await expect(page.getByText(m.ai.careSummary.resultTitle)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "care-preview-no-ai-action", ["no 'Organise with AI' action", "no dialog", "no AI marking in the preview", "no horizontal overflow"], article);

        await page.getByRole("button", { name: m.careSummary.approveAction }).click();
        await page.getByRole("button", { name: m.careSummary.printAction }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __c7PrintCalls?: number }).__c7PrintCalls ?? 0)).toBe(1);
        await page.emulateMedia({ media: "print" });
        await expect(article).not.toContainText(m.ai.demoTag);
        await expect(article).not.toContainText(m.ai.resultCheck);
        const printedText = await article.innerText();
        if (browserName === "chromium") await page.pdf({ path: `${evidencePath(context, "care-print-no-marking")}.pdf`, printBackground: true });
        await captureState(page, testInfo, context, "care-print-no-marking", [`approved deterministic preview printed once (window.print observed)`, "print media: no ai.demoTag / ai.resultCheck in the printed artifact", `printed draft-notice heading present: ${printedText.includes(m.careSummary.draftNotices.label)}`, browserName === "chromium" ? "printed PDF saved" : "PDF not available in this engine"], article);
        await page.emulateMedia({ media: null });

        tripwire.assertUntouched();
      });
    });
  }
}
