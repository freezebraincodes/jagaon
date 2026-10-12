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
  openTab,
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
 * Packet 11C C7, target 1: the PRODUCTION build as is. Packet 11C English activation (owner decisions Q and A, 2026-10-12): the shipped
 * manifest remote-enables the history explanation and the care-summary wording, and the shipped request-class records qualify the six
 * en-SG classes only (the six zh-SG classes stay PENDING). So in en-SG the History explanation asks the per-request disclosure first,
 * and in zh-SG it explains with the standard wording at once; the seeded care previews map to no qualified class, so no care AI action
 * appears in either locale. No test here accepts a disclosure: a tripwire fails the test if /api/ai/* is ever requested. Synthetic
 * data only. Technical evidence, not owner approval.
 */

test.afterEach(async ({}, testInfo) => recordTestResult(testInfo));

/**
 * C7 finding D1 (pre-existing; fixed in C7 fix round 1, regression tests in JagaOnApp.test.tsx "D1 (a)" and "D1 (b)"): on a first run,
 * the language chosen on Welcome used to be reverted to English when the newly created dataset finished opening. This is the real-browser
 * check of the Welcome-language path in the production build.
 */
test.describe("C7 finding D1: Welcome language choice on a first run", () => {
  test.use({ viewport: VIEWPORTS.mobile.viewport });
  test("zh-SG chosen on Welcome stays zh-SG after the new dataset opens @smoke", async ({ page }) => {
    const zh = messagesFor("zh-SG");
    await page.goto(`${PRODUCTION_URL}/`);
    await page.getByRole("radio", { name: "简体中文" }).check();
    await page.getByRole("button", { name: zh.onboarding.usePrepared }).click();
    await expect(page.getByRole("button", { name: zh.today.recordReading })).toBeVisible();
    // The dataset is open once the More screen's setting is enabled; the app must still be in zh-SG then.
    await page.getByRole("navigation").getByRole("button").last().click();
    await expect(page.getByRole("checkbox")).toBeEnabled();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(zh.more.title, { timeout: 5_000 });
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-SG");
  });
});

/**
 * Owner UI review (evidence and scope): one synthetic care preview that contains a patient-authored READY_TO_ASK question ("Add my own
 * question" saves the patient's own words as READY_TO_ASK), on screen and in the printed presentation. No AI question clarification.
 */
const SYNTHETIC_QUESTION = { "en-SG": "Can I keep my demo pen in my bag on hot days?", "zh-SG": "天气热的时候，我可以把演示用的笔放在包里吗？" } as const;
for (const locale of LOCALES) {
  test.describe(`production ${locale} 390: patient-authored question`, () => {
    test.use({ viewport: VIEWPORTS.mobile.viewport });
    test(`care preview with a patient-authored READY_TO_ASK question, on screen and printed (${locale}) @smoke`, async ({ page, browserName }, testInfo) => {
      const context: EvidenceContext = { target: "production", locale, viewport: VIEWPORTS.mobile.label, engine: browserName };
      planStates(testInfo, context, ["care-question-preview", "care-question-print"]);
      const tripwire = await shellTripwire(page);
      await stubWindowPrint(page);
      const m = await startPreparedProfile(page, PRODUCTION_URL, locale);
      const question = SYNTHETIC_QUESTION[locale];
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
      await expect(article.getByRole("heading", { level: 2, name: m.careSummary.questionsHeading })).toBeVisible();
      await expect(page.getByRole("button", { name: m.ai.careSummary.action })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await captureState(page, testInfo, context, "care-question-preview", ["patient-authored question saved with 'Add my own question' (READY_TO_ASK) and ticked", "preview shows it under the questions heading, in the patient's own words", "no AI action (shipped build: this preview's request is not a qualified class)"], article);
      await page.getByRole("button", { name: m.careSummary.approveAction }).click();
      await page.getByRole("button", { name: m.careSummary.printAction }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __c7PrintCalls?: number }).__c7PrintCalls ?? 0)).toBe(1);
      await page.emulateMedia({ media: "print" });
      const printed = await article.innerText();
      expect(printed).toContain(question);
      expect(printed).toContain(m.careSummary.questionsHeading);
      expect(printed).toContain(m.careSummary.draftNotices.label);
      if (browserName === "chromium") await page.pdf({ path: `${evidencePath(context, "care-question-print")}.pdf`, printBackground: true });
      await captureState(page, testInfo, context, "care-question-print", ["approved and printed once (window.print observed)", "print media: the question is printed under the questions heading, in the patient's own words (asserted)", "draft-notices heading printed (asserted)"], article);
      await page.emulateMedia({ media: null });
      tripwire.assertUntouched();
    });
  });
}

for (const viewportKey of Object.keys(VIEWPORTS) as ViewportKey[]) {
  const viewport = VIEWPORTS[viewportKey];
  for (const locale of LOCALES) {
    test.describe(`production ${locale} ${viewport.label}`, () => {
      test.use({ viewport: viewport.viewport, deviceScaleFactor: viewport.deviceScaleFactor });
      const smoke = viewportKey === "mobile" ? " @smoke" : "";

      // Packet 11C English activation (owner decisions Q and A; deliberate; was "deterministic only: no disclosure …" in both locales):
      // en-SG asks the disclosure first and Cancel keeps the standard wording; zh-SG never shows a dialog. Nothing is ever sent.
      const remoteOffered = locale === "en-SG";
      test(`shipped activation: ${remoteOffered ? "History disclosure first, Cancel keeps the standard wording" : "no History disclosure (class PENDING)"}; no care AI action on the seeded data; no AI marking; private-mode setting present; nothing sent (${locale}, ${viewport.label})${smoke}`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "production", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, [...(remoteOffered ? ["history-disclosure-first"] : []), "history-deterministic", "settings-private-toggle", "care-preview-no-ai-action", "care-print-no-marking"]);
        const tripwire = await shellTripwire(page);
        await installFocusProbe(page);
        await stubWindowPrint(page);
        const m = await startPreparedProfile(page, PRODUCTION_URL, locale);

        const action = await openHistory(page, m);
        await action.focus();
        await page.keyboard.press("Enter");
        const panel = page.getByRole("region", { name: m.history.explanation.title });
        if (remoteOffered) {
          // en-SG: the en-SG class is QUALIFIED, so the explicit action shows the per-request disclosure BEFORE any request, with the
          // demo passcode field (nothing held yet). Nothing has been sent.
          const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });
          await expect(dialog).toBeVisible();
          await expect(dialog).toHaveAttribute("aria-modal", "true");
          await expect(dialog.getByLabel(m.aiAccess.passcodeLabel)).toHaveAttribute("type", "password");
          expect(tripwire.hits).toEqual([]);
          await expectNoHorizontalOverflow(page);
          await captureState(page, testInfo, context, "history-disclosure-first", ["en-SG: the disclosure opens before any request", "aria-modal, named by the title", "passcode field shown (type=password)", "tripwire: no /api/ai/* request"], dialog);
          // Cancel (the safe action): the standard wording with the not-used line; nothing sent.
          await dialog.getByRole("button", { name: m.ai.cancel }).click();
          await expect(dialog).toHaveCount(0);
        }
        await expect(panel.getByRole("status")).not.toBeEmpty();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByText(m.aiAccess.passcodeLabel)).toHaveCount(0);
        await expect(panel.getByText(m.ai.demoTag)).toHaveCount(0);
        await expect(panel.getByText(m.ai.resultCheck)).toHaveCount(0);
        await expect(panel.getByRole("group")).toHaveCount(0);
        // en-SG after Cancel: the short not-used line; zh-SG: none (no remote request was possible).
        await expect(panel.getByText(m.ai.remoteNotAccepted)).toHaveCount(remoteOffered ? 1 : 0);
        await expect(panel.getByText(m.aiHistoryFallback.unavailableAfterRequest)).toHaveCount(0);
        await expect(action).toHaveAttribute("aria-expanded", "true");
        expect(tripwire.hits).toEqual([]);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "history-deterministic", [remoteOffered ? "after Cancel: no dialog, standard wording with the not-used line" : "zh-SG: no dialog, standard wording at once", "no passcode field", "role=status headline present", "no ai.demoTag / ai.resultCheck / AI group", "no horizontal overflow", "tripwire: no /api/ai/* request"], panel);

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

        // Care: the seeded glucose-readings preview is too large to send (not remote-eligible), so it has no AI action in either locale;
        // the printed artifact carries no AI marking.
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
        expect(printedText).not.toContain(m.ai.demoTag);
        expect(printedText).not.toContain(m.ai.resultCheck);
        expect(printedText).toContain(m.careSummary.draftNotices.label);
        if (browserName === "chromium") await page.pdf({ path: `${evidencePath(context, "care-print-no-marking")}.pdf`, printBackground: true });
        await captureState(page, testInfo, context, "care-print-no-marking", [`approved deterministic preview printed once (window.print observed)`, "print media: no ai.demoTag / ai.resultCheck in the printed artifact (asserted)", "draft-notices heading printed (asserted)", browserName === "chromium" ? "printed PDF saved" : "PDF not available in this engine"], article);
        await page.emulateMedia({ media: null });

        tripwire.assertUntouched();
      });
    });
  }
}
