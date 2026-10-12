import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AppMessages } from "@/i18n/types";
import {
  activeName,
  AI_HEADLINE_PREFIX,
  allBrowserStorage,
  captureState,
  DETERMINISTIC_HEADLINE_PREFIX,
  expectFocusTrapped,
  expectNoHorizontalOverflow,
  focusIndicatorVisible,
  focusMoves,
  focusSequence,
  HARNESS_URL,
  installFocusProbe,
  interceptShellRoute,
  LOCALES,
  notCaptured,
  openHistory,
  planStates,
  recordTestResult,
  startPreparedProfile,
  SYNTHETIC_PASSCODE,
  tabKeys,
  TECHNICAL_CODES,
  VIEWPORTS,
  type EvidenceContext,
  type Locale,
  type ViewportKey,
} from "./support";

/**
 * Packet 11C C7, target 2 (isolated harness): the Recorded-history explanation with the injected test activation and test-only
 * QUALIFIED records. Every /api/ai/shell answer is a fake typed body (route interception). Synthetic data only. Technical evidence,
 * not owner approval; presentation remains human acceptance pending.
 */

test.afterEach(async ({}, testInfo) => recordTestResult(testInfo));

const DIALOG = "[role=dialog]";

function panelOf(page: Page, m: AppMessages): Locator {
  return page.getByRole("region", { name: m.history.explanation.title });
}

/** `attemptedLine` (owner UI decision U12): the fallback line shown only after an attempted (POSTed) request failed or was refused. */
async function expectDeterministic(page: Page, m: AppMessages, locale: Locale, options: { declinedLine: boolean; attemptedLine?: boolean }) {
  const panel = panelOf(page, m);
  await expect(panel.getByRole("status")).toContainText(DETERMINISTIC_HEADLINE_PREFIX[locale]);
  await expect(panel.getByText(m.ai.demoTag)).toHaveCount(0);
  await expect(panel.getByText(m.ai.resultCheck)).toHaveCount(0);
  await expect(panel.getByRole("group")).toHaveCount(0);
  await expect(panel.getByText(m.ai.remoteNotAccepted)).toHaveCount(options.declinedLine ? 1 : 0);
  await expect(panel.getByText(m.aiHistoryFallback.unavailableAfterRequest)).toHaveCount(options.attemptedLine ? 1 : 0);
  const text = await page.locator("main").innerText();
  for (const code of TECHNICAL_CODES) expect(text, code).not.toContain(code);
}

async function expectAccepted(page: Page, m: AppMessages, locale: Locale) {
  const panel = panelOf(page, m);
  await expect(panel.getByRole("status")).toContainText(AI_HEADLINE_PREFIX[locale]);
  await expect(panel.getByRole("group", { name: m.ai.demoTag })).toBeVisible();
  await expect(panel.getByText(m.ai.resultCheck)).toBeVisible();
  await expect(panel).toHaveAttribute("aria-busy", "false");
}

/** Opens the explanation for `action`'s comparison (closing an open one first) and returns the disclosure dialog, if any. */
async function requestExplanation(page: Page, m: AppMessages, action: Locator): Promise<void> {
  if ((await action.getAttribute("aria-expanded")) === "true") {
    await action.click();
    await expect(action).toHaveAttribute("aria-expanded", "false");
  }
  await action.click();
}

async function acceptDisclosure(page: Page, m: AppMessages, options: { passcode: boolean }) {
  const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel(m.aiAccess.passcodeLabel);
  if (options.passcode) await field.fill(SYNTHETIC_PASSCODE);
  else await expect(field).toHaveCount(0);
  await dialog.getByRole("button", { name: m.ai.pattern.confirm }).click();
  await expect(dialog).toHaveCount(0);
}

for (const viewportKey of Object.keys(VIEWPORTS) as ViewportKey[]) {
  const viewport = VIEWPORTS[viewportKey];
  for (const locale of LOCALES) {
    test.describe(`harness history ${locale} ${viewport.label}`, () => {
      test.use({ viewport: viewport.viewport, deviceScaleFactor: viewport.deviceScaleFactor });
      const smoke = viewportKey === "mobile" ? " @smoke" : "";

      test(`disclosure per request, keyboard and focus, passcode, loading, accepted wording (${locale}, ${viewport.label})${smoke}`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "harness", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, ["history-tab-order", "history-dialog", "history-escape-declined", "history-loading", "history-accepted", "history-passcode-not-persisted"]);
        await installFocusProbe(page);
        const shell = await interceptShellRoute(page);
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        const action = await openHistory(page, m);

        // Tab order from the top of the document reaches the period control (its checked option: openHistory selects "Last week", since
        // the prepared demo data ends yesterday), the explanation action and the screen's own actions.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const keys = tabKeys(browserName);
        const sequence = await focusSequence(page, 40, keys.next);
        const actionName = `button|${m.history.explanation.action}`;
        for (const expected of [`input:radio|${m.history.periodLastWeek}`, actionName, `button|${m.history.addFacts}`, `button|${m.history.selectFacts}`, `button|${m.shared.navToday}`, `button|${m.shared.navMore}`]) {
          expect(sequence.some((name) => name.startsWith(expected)), `${expected} in ${sequence.join(" > ")}`).toBe(true);
        }
        await action.focus();
        expect(await focusIndicatorVisible(page)).toBe(true);
        await action.scrollIntoViewIfNeeded();
        await captureState(page, testInfo, context, "history-tab-order", [`${keys.next} reaches: ${[...new Set(sequence)].join(" > ")}`, "visible focus indicator on the explanation action (screenshot)"]);

        // The disclosure, shown BEFORE any request: modal, labelled, initial focus on the safe action, focus trapped, masked passcode.
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAttribute("aria-modal", "true");
        await expect(dialog.getByText(m.ai.remoteBody)).toBeVisible();
        await expect(dialog.getByText(m.ai.remoteLimit)).toBeVisible();
        expect(await activeName(page)).toBe(`button|${m.ai.cancel}`);
        const field = dialog.getByLabel(m.aiAccess.passcodeLabel);
        await expect(field).toHaveAttribute("type", "password");
        // Owner UI decision U03: the primary action waits for non-whitespace passcode input; Cancel stays available.
        const confirmButton = dialog.getByRole("button", { name: m.ai.pattern.confirm });
        await expect(confirmButton).toBeDisabled();
        await expect(dialog.getByRole("button", { name: m.ai.cancel })).toBeEnabled();
        await field.fill("   ");
        await expect(confirmButton).toBeDisabled();
        await field.fill("");
        const emptyCycle = await expectFocusTrapped(page, DIALOG, 4, keys.next);
        expect(new Set(emptyCycle)).toEqual(new Set([`input:password|${m.aiAccess.passcodeLabel}`, `button|${m.ai.cancel}`]));
        await field.fill(SYNTHETIC_PASSCODE);
        await expect(confirmButton).toBeEnabled();
        const forward = await expectFocusTrapped(page, DIALOG, 6, keys.next);
        const backward = await expectFocusTrapped(page, DIALOG, 6, keys.previous);
        expect(new Set(forward)).toEqual(new Set([`input:password|${m.aiAccess.passcodeLabel}`, `button|${m.ai.pattern.confirm}`, `button|${m.ai.cancel}`]));
        expect(await focusIndicatorVisible(page)).toBe(true);
        expect(shell.calls).toHaveLength(0);
        await expectNoHorizontalOverflow(page);
        // Every part of the sheet is reachable in the viewport (it scrolls vertically when taller than the viewport, e.g. at 200%).
        const sheet = await dialog.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowY: getComputedStyle(element).overflowY }));
        for (const part of [dialog.getByRole("heading", { name: m.ai.remoteTitle }), dialog.getByText(m.ai.remoteLimit), dialog.getByRole("button", { name: m.ai.cancel })]) {
          await part.scrollIntoViewIfNeeded();
          await expect(part).toBeInViewport();
        }
        await dialog.getByRole("button", { name: m.ai.cancel }).scrollIntoViewIfNeeded();
        await captureState(page, testInfo, context, "history-dialog", [`sheet ${sheet.scrollHeight}px content in ${sheet.clientHeight}px (overflow-y ${sheet.overflowY}); title, limit and Cancel each scroll into the viewport`, "dialog before any request (0 POSTs)", "aria-modal, named by the title, described by body and limit", "initial focus on Cancel", "U03: primary action disabled while the passcode field is empty or whitespace, enabled with input; Cancel always enabled", `Tab cycle with the field empty: ${emptyCycle.join(" > ")}`, `Tab cycle with a passcode entered stays inside: ${forward.join(" > ")}`, `Shift+Tab cycle stays inside: ${backward.join(" > ")}`, "passcode field type=password", "visible focus indicator", "no horizontal overflow"], dialog);

        // Escape takes the safe action: declined, focus returns to the action, standard wording with the non-technical line; nothing sent.
        const movesBefore = (await focusMoves(page)).length;
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expectDeterministic(page, m, locale, { declinedLine: true });
        // The dialog returns focus to the control that opened it; the explanation panel that then opens moves focus to its heading.
        const afterEscape = (await focusMoves(page)).slice(movesBefore);
        expect(afterEscape[0], afterEscape.join(" > ")).toBe(actionName);
        expect(await activeName(page)).toBe(`h3|${m.history.explanation.title}`);
        expect(shell.calls).toHaveLength(0);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "history-escape-declined", ["Escape closed the dialog", `focus moves after Escape: ${afterEscape.join(" > ")} (returned to the invoking action, then the opened panel's heading)`, "standard wording + ai.remoteNotAccepted line", "no AI tag", "0 POSTs"], panelOf(page, m));

        // A new request asks again (per-request disclosure). Accept with the passcode; the fake route holds the answer: loading.
        shell.answer({ kind: "HOLD_THEN_ACCEPT" });
        await requestExplanation(page, m, action);
        await expect(dialog).toBeVisible();
        await field.fill(SYNTHETIC_PASSCODE);
        await dialog.getByRole("button", { name: m.ai.pattern.confirm }).focus();
        await page.keyboard.press("Enter");
        await expect(dialog).toHaveCount(0);
        await shell.waitForCalls(1);
        const panel = panelOf(page, m);
        await expect(panel).toHaveAttribute("aria-busy", "true");
        await expect(panel.getByText(m.shared.loading)).toBeVisible();
        await expect(panel.getByRole("status")).toHaveCount(1);
        await expect(panel.getByRole("status")).toBeEmpty();
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "history-loading", ["second request asked the disclosure again", "panel aria-busy=true with the loading text", "role=status live region present (empty until the result)", "1 POST in flight"], panel);

        shell.release();
        await expectAccepted(page, m, locale);
        expect(await activeName(page)).toBe(`h3|${m.history.explanation.title}`);
        expect(shell.calls.map((call) => call.answered)).toEqual(["HELD"]);
        expect(shell.calls[0]!.passcodeHeader).toBe(SYNTHETIC_PASSCODE);
        expect(shell.calls[0]!.body).not.toContain(SYNTHETIC_PASSCODE);
        expect(shell.calls[0]!.locale).toBe(locale);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "history-accepted", ["role=status announces the AI headline", "labelled group named ai.demoTag wraps the generated text", "ai.resultCheck shown", "focus moved to the panel heading", "passcode sent only as the request header, never in the body", "no horizontal overflow"], panel);

        // The passcode is never persisted: not in localStorage, sessionStorage or any IndexedDB database.
        const stored = await allBrowserStorage(page);
        expect(stored.length).toBeGreaterThan(0);
        expect(stored).not.toContain(SYNTHETIC_PASSCODE);
        await captureState(page, testInfo, context, "history-passcode-not-persisted", ["passcode field was type=password", "no passcode in localStorage, sessionStorage or any IndexedDB database after the flow"]);
      });

      test(`decline, repair, fallback, refusals, superseded request, switch off (${locale}, ${viewport.label})`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "harness", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, ["history-declined", "history-repair-accepted", "history-fallback-failed", "history-fallback-rejected", "history-refused-spend", "history-credit-limit-dialog", "history-credit-limit-balance", "history-refused-access-denied", "history-passcode-asked-again", "history-superseded", "history-refused-switch-off", "history-switch-off-no-dialog", "history-moot-locale-switch"]);
        await installFocusProbe(page);
        const shell = await interceptShellRoute(page);
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        const action = await openHistory(page, m);
        const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });

        // Cancel (the safe action): declined, standard wording with the non-technical line; nothing sent.
        await requestExplanation(page, m, action);
        await dialog.getByRole("button", { name: m.ai.cancel }).click();
        await expectDeterministic(page, m, locale, { declinedLine: true });
        expect(shell.calls).toHaveLength(0);
        await captureState(page, testInfo, context, "history-declined", ["Cancel: standard wording + ai.remoteNotAccepted", "0 POSTs"], panelOf(page, m));

        // One structural rejection, one repair: ONE dialog, two POSTs, accepted wording.
        shell.answer({ kind: "REPAIR_THEN_ACCEPT" });
        await requestExplanation(page, m, action);
        await acceptDisclosure(page, m, { passcode: true });
        await expectAccepted(page, m, locale);
        await expect(dialog).toHaveCount(0);
        expect(shell.calls.map((call) => call.answered)).toEqual(["STRUCTURALLY_REJECTED:SCHEMA_INVALID", "CANDIDATE"]);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "history-repair-accepted", ["one dialog for the request", "2 POSTs: STRUCTURALLY_REJECTED (SCHEMA_INVALID, repairable) then the repair's CANDIDATE", "accepted wording with ai.demoTag and ai.resultCheck"], panelOf(page, m));

        // Failures fall back to the standard wording (no tag, no technical text). The passcode is held: no field any more.
        // Owner decision 2026-10-12 (AI credit dialog; deliberate change): "history-refused-spend" is now a spend refusal that is NOT a
        // used-up credit (SPEND_LEDGER_UNAVAILABLE, U12's line); SPEND_CEILING_REACHED shows the credit dialog (below).
        const fallbacks = [
          ["history-fallback-failed", { kind: "FAILED", reason: "PROVIDER_FAILED" }, "FAILED:PROVIDER_FAILED"],
          ["history-fallback-rejected", { kind: "REJECT_UNREPAIRABLE" }, "STRUCTURALLY_REJECTED:CLINICAL_MEANING_VIOLATION"],
          ["history-refused-spend", { kind: "REFUSED", reason: "SPEND_LEDGER_UNAVAILABLE" }, "REFUSED:SPEND_LEDGER_UNAVAILABLE"],
        ] as const;
        for (const [state, answer, answered] of fallbacks) {
          const before = shell.calls.length;
          shell.answer(answer);
          await requestExplanation(page, m, action);
          await acceptDisclosure(page, m, { passcode: false });
          await expectDeterministic(page, m, locale, { declinedLine: false, attemptedLine: true });
          expect(shell.calls.slice(before).map((call) => call.answered)).toEqual([answered]);
          await expectNoHorizontalOverflow(page);
          await captureState(page, testInfo, context, state, [`fake answer ${answered}`, "one POST, no repair", "standard wording, no AI tag, no closed code shown", "U12: the owner's fallback line (aiHistoryFallback) shown after the attempted POST; no ai.remoteNotAccepted"], panelOf(page, m));
        }

        // Owner decision 2026-10-12 (AI credit dialog): the daily limit (403 SPEND_CEILING_REACHED) and the DeepSeek balance (FAILED
        // OPERATIONAL_SPEND_LOCKED, the route's answer to HTTP 402) show the credit dialog (focus on OK); OK closes it and the standard
        // wording stays, without U12's line.
        const credits = [
          ["history-credit-limit-dialog", { kind: "REFUSED", reason: "SPEND_CEILING_REACHED" }, "REFUSED:SPEND_CEILING_REACHED"],
          ["history-credit-limit-balance", { kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED" }, "FAILED:OPERATIONAL_SPEND_LOCKED"],
        ] as const;
        for (const [state, answer, answered] of credits) {
          const before = shell.calls.length;
          shell.answer(answer);
          await requestExplanation(page, m, action);
          await acceptDisclosure(page, m, { passcode: false });
          const credit = page.getByRole("dialog", { name: m.aiCreditLimit.title });
          await expect(credit).toBeVisible();
          await expect(credit).toContainText(m.aiCreditLimit.historyBody);
          const ok = credit.getByRole("button", { name: m.aiCreditLimit.ok });
          await expect(ok).toBeFocused();
          await expectNoHorizontalOverflow(page);
          await captureState(page, testInfo, context, state, [`fake answer ${answered}`, "credit dialog: aiCreditLimit.title and historyBody, one OK action, focus on OK", "one POST, no repair"], credit);
          await ok.click();
          await expect(credit).toHaveCount(0);
          await expectDeterministic(page, m, locale, { declinedLine: false, attemptedLine: false });
          expect(shell.calls.slice(before).map((call) => call.answered)).toEqual([answered]);
        }

        // ACCESS_DENIED: standard wording, and the passcode is forgotten, so the next disclosure asks for it again.
        shell.answer({ kind: "REFUSED", reason: "ACCESS_DENIED" });
        await requestExplanation(page, m, action);
        await acceptDisclosure(page, m, { passcode: false });
        await expectDeterministic(page, m, locale, { declinedLine: false, attemptedLine: true });
        expect(shell.calls.at(-1)!.answered).toBe("REFUSED:ACCESS_DENIED");
        await captureState(page, testInfo, context, "history-refused-access-denied", ["fake 403 REFUSED ACCESS_DENIED", "standard wording + U12 fallback line, no AI tag, no closed code shown"], panelOf(page, m));
        await requestExplanation(page, m, action);
        await expect(dialog.getByLabel(m.aiAccess.passcodeLabel)).toBeVisible();
        await captureState(page, testInfo, context, "history-passcode-asked-again", ["after ACCESS_DENIED the next disclosure shows the passcode field again"], dialog);

        // Superseded: a held request on this period's comparison, then a period change and a second comparison's request.
        shell.answer({ kind: "HOLD_THEN_ACCEPT" });
        const beforeHeld = shell.calls.length;
        await dialog.getByLabel(m.aiAccess.passcodeLabel).fill(SYNTHETIC_PASSCODE);
        await dialog.getByRole("button", { name: m.ai.pattern.confirm }).click();
        await shell.waitForCalls(beforeHeld + 1);
        await expect(panelOf(page, m)).toHaveAttribute("aria-busy", "true");
        await page.getByRole("radio", { name: m.history.periodThirtyDays }).check({ force: true });
        await expect(panelOf(page, m)).toHaveCount(0);
        shell.answer({ kind: "ACCEPT" });
        const second = page.getByRole("button", { name: m.history.explanation.action }).first();
        await requestExplanation(page, m, second);
        await acceptDisclosure(page, m, { passcode: false });
        await expectAccepted(page, m, locale);
        shell.release();
        await expect.poll(() => shell.aborted.length).toBeGreaterThanOrEqual(1);
        await expect(panelOf(page, m)).toHaveCount(1);
        await expectAccepted(page, m, locale);
        await expect(page.getByRole("radio", { name: m.history.periodThirtyDays })).toBeChecked();
        expect(shell.calls.slice(beforeHeld).map((call) => call.answered)).toEqual(["HELD", "CANDIDATE"]);
        await captureState(page, testInfo, context, "history-superseded", ["first request held, then the period changed (its panel closed and the request was aborted)", "the 30-day comparison's own request asked its own disclosure and was accepted", "the released first answer was discarded by the browser (aborted), never shown"], panelOf(page, m));

        // REMOTE_AI_DISABLED: standard wording; the runtime learns the switch is off: no further disclosure, nothing sent.
        shell.answer({ kind: "REFUSED", reason: "REMOTE_AI_DISABLED" });
        await requestExplanation(page, m, second);
        await acceptDisclosure(page, m, { passcode: false });
        await expectDeterministic(page, m, locale, { declinedLine: false, attemptedLine: true });
        expect(shell.calls.at(-1)!.answered).toBe("REFUSED:REMOTE_AI_DISABLED");
        await captureState(page, testInfo, context, "history-refused-switch-off", ["fake 403 REFUSED REMOTE_AI_DISABLED", "standard wording + U12 fallback line, no AI tag, no closed code shown"], panelOf(page, m));
        const callsBefore = shell.calls.length;
        await requestExplanation(page, m, second);
        await expectDeterministic(page, m, locale, { declinedLine: false, attemptedLine: false });
        await expect(dialog).toHaveCount(0);
        expect(shell.calls.length).toBe(callsBefore);
        await captureState(page, testInfo, context, "history-switch-off-no-dialog", ["after REMOTE_AI_DISABLED: no disclosure, standard wording, 0 further POSTs", "U12: no fallback line (nothing attempted for this request)"], panelOf(page, m));

        notCaptured(
          testInfo,
          context,
          "history-moot-locale-switch",
          "Not reachable through the real UI: the disclosure is modal (backdrop over the app, focus trapped) and the language control is on the More screen, so a locale switch with the dialog open cannot be performed by a user in one tab. Covered offline by RecordedHistoryScreen/JagaOnApp component tests (DISCLOSURE_CLOSED_MOOT).",
        );
      });

      // Owner decision 2026-10-12 (optional passcodes): a deployment with no JAGAON_AI_DEMO_PASSCODE (the fake probe answers
      // passcodeRequired: false): the disclosure stays, without the passcode field; the POST carries no passcode header.
      test(`no passcode configured: the disclosure without a passcode field; no passcode header (${locale}, ${viewport.label})${smoke}`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "harness", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, ["history-no-passcode-dialog", "history-no-passcode-accepted"]);
        const shell = await interceptShellRoute(page, { requirePasscode: false });
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        const action = await openHistory(page, m);
        await requestExplanation(page, m, action);
        const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel(m.aiAccess.passcodeLabel)).toHaveCount(0);
        await expect(dialog.locator("input")).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: m.ai.cancel })).toBeFocused();
        const confirm = dialog.getByRole("button", { name: m.ai.pattern.confirm });
        await expect(confirm).toBeEnabled();
        expect(shell.calls).toHaveLength(0);
        expect(shell.probes.length).toBeGreaterThanOrEqual(1);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "history-no-passcode-dialog", ["passcode probe answered passcodeRequired: false", "disclosure shown before the request, no passcode field", "primary action enabled at once; initial focus on Cancel", "0 POSTs"], dialog);
        await confirm.click();
        await expectAccepted(page, m, locale);
        expect(shell.calls.map((call) => [call.answered, call.passcodeHeader])).toEqual([["CANDIDATE", null]]);
        await captureState(page, testInfo, context, "history-no-passcode-accepted", ["one POST without the passcode header", "accepted wording with ai.demoTag and ai.resultCheck"], panelOf(page, m));
      });
    });
  }
}
