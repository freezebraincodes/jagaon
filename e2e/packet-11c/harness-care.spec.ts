import { expect, test, type Page } from "@playwright/test";
import type { AppMessages } from "@/i18n/types";
import {
  activeName,
  captureState,
  evidencePath,
  expectFocusTrapped,
  expectNoHorizontalOverflow,
  focusMoves,
  HARNESS_URL,
  installFocusProbe,
  interceptShellRoute,
  LOCALES,
  openCarePreview,
  planStates,
  recordTestResult,
  startPreparedProfile,
  stubWindowPrint,
  SYNTHETIC_PASSCODE,
  tabKeys,
  TECHNICAL_CODES,
  VIEWPORTS,
  type EvidenceContext,
  type Locale,
  type ViewportKey,
} from "./support";

/**
 * Packet 11C C7, target 2 (isolated harness): the care-summary AI wording with the injected test activation and test-only QUALIFIED
 * records; every /api/ai/shell answer is a fake typed body (route interception). The printed artifact is checked in print media
 * (and saved as a PDF in Chromium). Synthetic data only. Technical evidence, not owner approval; human acceptance pending.
 */

test.afterEach(async ({}, testInfo) => recordTestResult(testInfo));

/** The two catalogue sentences, joined as the screen joins them (a space in en-SG, directly in zh-SG). */
const joined = (locale: Locale, first: string, second: string) => (locale === "zh-SG" ? `${first}${second}` : `${first} ${second}`);

async function expectNoTechnicalText(page: Page) {
  const text = await page.locator("main").innerText();
  for (const code of TECHNICAL_CODES) expect(text, code).not.toContain(code);
}

function aiLine(page: Page) {
  return page.locator(".care-summary-ai-line");
}

async function openCareDisclosure(page: Page, m: AppMessages) {
  await page.getByRole("button", { name: m.ai.careSummary.action }).click();
  const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const viewportKey of Object.keys(VIEWPORTS) as ViewportKey[]) {
  const viewport = VIEWPORTS[viewportKey];
  for (const locale of LOCALES) {
    test.describe(`harness care ${locale} ${viewport.label}`, () => {
      test.use({ viewport: viewport.viewport, deviceScaleFactor: viewport.deviceScaleFactor });
      const smoke = viewportKey === "mobile" ? " @smoke" : "";

      test(`qualified preview: AI action, decline, refusal, fallback, loading and cancel, accepted marking, printed artifact (${locale}, ${viewport.label})${smoke}`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "harness", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, ["care-ai-action-visible", "care-deterministic-print", "care-dialog", "care-declined", "care-refused", "care-fallback", "care-loading", "care-cancelled", "care-ai-preview", "care-ai-print"]);
        await installFocusProbe(page);
        await stubWindowPrint(page);
        const shell = await interceptShellRoute(page);
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        const article = await openCarePreview(page, m, "insulinRecords");

        // A qualified deterministic preview offers the AI action; it carries no AI marking (screen and print).
        const action = page.getByRole("button", { name: m.ai.careSummary.action });
        await expect(action).toBeVisible();
        await expect(article).not.toContainText(m.ai.demoTag);
        await expect(article).not.toContainText(m.ai.resultCheck);
        expect(shell.calls).toHaveLength(0);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "care-ai-action-visible", ["qualified preview (test-only QUALIFIED record) shows 'Organise with AI'", "deterministic preview: no AI marking", "0 POSTs", "no horizontal overflow"], article);
        await page.emulateMedia({ media: "print" });
        await expect(article).not.toContainText(m.ai.demoTag);
        const deterministicPrint = await article.innerText();
        if (browserName === "chromium") await page.pdf({ path: `${evidencePath(context, "care-deterministic-print")}.pdf`, printBackground: true });
        await captureState(page, testInfo, context, "care-deterministic-print", ["print media: no ai.demoTag / ai.resultCheck", `draft-notice heading printed: ${deterministicPrint.includes(m.careSummary.draftNotices.label)}`, browserName === "chromium" ? "printed PDF saved" : "PDF not available in this engine"], article);
        await page.emulateMedia({ media: null });

        // The disclosure for the care request: modal, safe initial focus, focus trapped; Escape declines and focus returns to the action.
        await action.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: m.ai.careSummary.confirm })).toBeVisible();
        expect(await activeName(page)).toBe(`button|${m.ai.cancel}`);
        await expect(dialog.getByLabel(m.aiAccess.passcodeLabel)).toHaveAttribute("type", "password");
        const cycle = await expectFocusTrapped(page, "[role=dialog]", 6, tabKeys(browserName).next);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "care-dialog", ["care flow's own disclosure (confirm: ai.careSummary.confirm)", "initial focus on Cancel", `Tab cycle stays inside: ${cycle.join(" > ")}`, "passcode field type=password", "0 POSTs"], dialog);
        const movesBefore = (await focusMoves(page)).length;
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(aiLine(page)).toHaveText(m.ai.remoteNotAccepted);
        await expect(aiLine(page)).toHaveAttribute("aria-live", "polite");
        // Focus returns to the invoking control: the same button element, which reads "Cancel" (the AI request's own Cancel) while the
        // declined request settles and "Organise with AI" again afterwards.
        const afterEscape = (await focusMoves(page)).slice(movesBefore);
        expect(afterEscape, afterEscape.join(" > ")).toHaveLength(1);
        expect([`button|${m.ai.careSummary.action}`, `button|${m.ai.cancel}`]).toContain(afterEscape[0]);
        await expect.poll(() => activeName(page)).toBe(`button|${m.ai.careSummary.action}`);
        await expect(action).toBeFocused();
        expect(shell.calls).toHaveLength(0);
        await expect(article).not.toContainText(m.ai.demoTag);
        await captureState(page, testInfo, context, "care-declined", ["Escape declined: line ai.remoteNotAccepted in a polite live region", `focus returned to the invoking button (one move: ${afterEscape.join(" > ")}; the same element reads 'Organise with AI' once settled)`, "preview unchanged, 0 POSTs"], page.locator(".care-summary-ai"));

        // A refusal (fake 403 SPEND_CEILING_REACHED): the deterministic preview stays, with the non-technical fallback line and Retry.
        shell.answer({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED" });
        let open = await openCareDisclosure(page, m);
        await open.getByLabel(m.aiAccess.passcodeLabel).fill(SYNTHETIC_PASSCODE);
        await open.getByRole("button", { name: m.ai.careSummary.confirm }).click();
        await expect(aiLine(page)).toHaveText(joined(locale, m.ai.unavailable, m.ai.careSummary.fallback));
        await expect(page.getByRole("button", { name: m.ai.retry })).toBeVisible();
        await expect(article).not.toContainText(m.ai.demoTag);
        await expectNoTechnicalText(page);
        expect(shell.calls.map((call) => call.answered)).toEqual(["REFUSED:SPEND_CEILING_REACHED"]);
        await captureState(page, testInfo, context, "care-refused", ["fake 403 REFUSED SPEND_CEILING_REACHED", "line: ai.unavailable + ai.careSummary.fallback", "Retry offered", "preview unchanged, no closed code shown"], page.locator(".care-summary-ai"));

        // Retry asks again (per request). A failure after a provider call (fake FAILED PROVIDER_TIMEOUT): the same fallback.
        shell.answer({ kind: "FAILED", reason: "PROVIDER_TIMEOUT" });
        await page.getByRole("button", { name: m.ai.retry }).click();
        open = page.getByRole("dialog", { name: m.ai.remoteTitle });
        await expect(open).toBeVisible();
        await expect(open.getByLabel(m.aiAccess.passcodeLabel)).toHaveCount(0);
        await open.getByRole("button", { name: m.ai.careSummary.confirm }).click();
        await expect(aiLine(page)).toHaveText(joined(locale, m.ai.unavailable, m.ai.careSummary.fallback));
        await expectNoTechnicalText(page);
        expect(shell.calls.at(-1)!.answered).toBe("FAILED:PROVIDER_TIMEOUT");
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "care-fallback", ["Retry showed a new disclosure (passcode already held: no field)", "fake FAILED PROVIDER_TIMEOUT (with upper-bound usage)", "fallback line, preview unchanged"], page.locator(".care-summary-ai"));

        // Loading, then Cancel: the late answer is discarded.
        shell.answer({ kind: "HOLD_THEN_ACCEPT" });
        await page.getByRole("button", { name: m.ai.retry }).click();
        await page.getByRole("dialog", { name: m.ai.remoteTitle }).getByRole("button", { name: m.ai.careSummary.confirm }).click();
        await expect(aiLine(page)).toHaveText(m.ai.careSummary.loading);
        await expect(page.getByRole("button", { name: m.careSummary.approveAction })).toBeDisabled();
        const cancel = page.locator(".care-summary-ai").getByRole("button", { name: m.ai.cancel });
        await expect(cancel).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "care-loading", ["line ai.careSummary.loading in a polite live region", "Cancel offered", "Approve disabled while loading"], page.locator(".care-summary-ai"));
        await cancel.click();
        await expect(aiLine(page)).toHaveText(m.ai.cancelled);
        shell.release();
        await expect.poll(() => shell.aborted.length).toBeGreaterThanOrEqual(1);
        await expect(page.getByText(m.ai.careSummary.resultTitle)).toHaveCount(0);
        await expect(article).not.toContainText(m.ai.demoTag);
        await captureState(page, testInfo, context, "care-cancelled", ["Cancel: line ai.cancelled", "the request was aborted; the late answer was never shown", "preview unchanged"], page.locator(".care-summary-ai"));

        // Accepted: the AI-assisted preview replaces the deterministic one, labelled, with the printed AI marking.
        shell.answer({ kind: "ACCEPT" });
        await page.getByRole("button", { name: m.ai.careSummary.action }).click();
        await page.getByRole("dialog", { name: m.ai.remoteTitle }).getByRole("button", { name: m.ai.careSummary.confirm }).click();
        const result = page.getByRole("region", { name: m.ai.careSummary.resultTitle });
        await expect(result).toBeVisible();
        await expect(result).toBeFocused();
        await expect(result).toContainText(m.ai.careSummary.resultBody);
        await expect(article).toContainText(m.ai.demoTag);
        await expect(article).toContainText(m.ai.resultCheck);
        await expect(page.getByRole("button", { name: m.ai.careSummary.action })).toHaveCount(0);
        expect(shell.calls.at(-1)!.answered).toBe("CANDIDATE");
        expect(shell.calls.at(-1)!.taskType).toBe("DRAFT_CARE_PREPARATION_SUMMARY");
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "care-ai-preview", ["accepted fake CANDIDATE replaced the preview", "region 'AI-assisted organisation' focused (announced)", "preview shows the AI_MARKING block: ai.demoTag + ai.resultCheck", "no further AI action on the AI-assisted preview"], article);

        // Approve, print (window.print observed), and the printed artifact in print media.
        await page.getByRole("button", { name: m.careSummary.approveAction }).click();
        await page.getByRole("button", { name: m.careSummary.printAction }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __c7PrintCalls?: number }).__c7PrintCalls ?? 0)).toBe(1);
        await page.emulateMedia({ media: "print" });
        const printed = await article.innerText();
        expect(printed).toContain(m.ai.demoTag);
        expect(printed).toContain(m.ai.resultCheck);
        expect(printed).toContain(m.careSummary.draftNotices.label);
        if (browserName === "chromium") await page.pdf({ path: `${evidencePath(context, "care-ai-print")}.pdf`, printBackground: true });
        await captureState(page, testInfo, context, "care-ai-print", ["approved AI-assisted snapshot printed once (window.print observed)", "print media: AI_MARKING block (ai.demoTag + ai.resultCheck) and the draft notices section printed", browserName === "chromium" ? "printed PDF saved" : "PDF not available in this engine"], article);
        await page.emulateMedia({ media: null });
      });

      test(`not qualified (shipped all-PENDING records under the test manifest): no disclosure, no care AI action, nothing sent (${locale}, ${viewport.label})`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "harness", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, ["not-qualified-history", "not-qualified-care"]);
        const shell = await interceptShellRoute(page);
        const m = await startPreparedProfile(page, HARNESS_URL, locale, "?records=shipped");
        await expect(page.locator("[data-c7-records=shipped]")).toHaveCount(1);
        await page.getByRole("navigation").getByRole("button", { name: m.shared.navHistory }).click();
        const actionButton = page.getByRole("button", { name: m.history.explanation.action }).first();
        await actionButton.click();
        const panel = page.getByRole("region", { name: m.history.explanation.title });
        await expect(panel.getByRole("status")).not.toBeEmpty();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(panel.getByText(m.ai.demoTag)).toHaveCount(0);
        await captureState(page, testInfo, context, "not-qualified-history", ["test manifest, shipped PENDING records: no disclosure", "standard wording, no AI tag", "0 POSTs"], panel);
        const article = await openCarePreview(page, m, "insulinRecords");
        await expect(page.getByRole("button", { name: m.ai.careSummary.action })).toHaveCount(0);
        await expect(article).not.toContainText(m.ai.demoTag);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "not-qualified-care", ["unqualified preview: no 'Organise with AI' action", "no AI marking"], article);
        expect(shell.calls).toHaveLength(0);
      });
    });
  }
}
