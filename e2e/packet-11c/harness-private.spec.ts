import { expect, test } from "@playwright/test";
import { AI_SHELL_ACCESS_HEADER } from "@/application/ai/ai-shell-route-contract";
import {
  captureState,
  DETERMINISTIC_HEADLINE_PREFIX,
  expectNoHorizontalOverflow,
  HARNESS_URL,
  interceptShellRoute,
  LOCALES,
  openCarePreview,
  openHistory,
  planStates,
  recordTestResult,
  setKeepWordingOnDevice,
  startPreparedProfile,
  VIEWPORTS,
  type EvidenceContext,
  type ViewportKey,
} from "./support";

/**
 * Packet 11C C7, target 2 (isolated harness): "Keep wording on this device" (C2). On: no disclosure, no care AI action, standard
 * wording and ZERO /api/ai/shell requests even with the test activation and QUALIFIED records. Off: the disclosure returns.
 */

test.afterEach(async ({}, testInfo) => recordTestResult(testInfo));

for (const viewportKey of Object.keys(VIEWPORTS) as ViewportKey[]) {
  const viewport = VIEWPORTS[viewportKey];
  for (const locale of LOCALES) {
    test.describe(`harness private mode ${locale} ${viewport.label}`, () => {
      test.use({ viewport: viewport.viewport, deviceScaleFactor: viewport.deviceScaleFactor });
      const smoke = viewportKey === "mobile" ? " @smoke" : "";

      test(`keep wording on this device: on = no dialog, no AI action, zero requests; off = the dialog returns (${locale}, ${viewport.label})${smoke}`, async ({ page, browserName }, testInfo) => {
        const context: EvidenceContext = { target: "harness", locale, viewport: viewport.label, engine: browserName };
        planStates(testInfo, context, ["private-on-setting", "private-on-history", "private-on-care", "private-off-dialog-returns"]);
        const shell = await interceptShellRoute(page);
        // Integration (2026-10-12, deliberate): recorded with method and body, so the credential-free passcode probe (GET, no body) can be
        // told apart from a request that sends anything.
        const requests: string[] = [];
        page.on("request", (request) => {
          if (/\/api\/ai\//.test(request.url())) {
            const url = new URL(request.url());
            requests.push(`${request.method()} ${url.pathname}${url.search}${request.postData() === null ? "" : " +body"}${request.headers()[AI_SHELL_ACCESS_HEADER] === undefined ? "" : " +passcode"}`);
          }
        });
        const m = await startPreparedProfile(page, HARNESS_URL, locale);

        await setKeepWordingOnDevice(page, m, true);
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "private-on-setting", ["'Keep wording on this device' checked on the More screen"], page.getByRole("region", { name: m.more.settingsHeading }));

        const action = await openHistory(page, m);
        await action.click();
        const panel = page.getByRole("region", { name: m.history.explanation.title });
        await expect(panel.getByRole("status")).toContainText(DETERMINISTIC_HEADLINE_PREFIX[locale]);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(panel.getByText(m.ai.demoTag)).toHaveCount(0);
        await expect(panel.getByText(m.aiHistoryFallback.unavailableAfterRequest)).toHaveCount(0);
        await expect(page.getByText(m.aiAccess.passcodeLabel)).toHaveCount(0);
        await captureState(page, testInfo, context, "private-on-history", ["no disclosure, no passcode field", "standard wording, no AI tag", "0 /api/ai requests"], panel);

        const article = await openCarePreview(page, m, "insulinRecords");
        await expect(page.getByRole("button", { name: m.ai.careSummary.action })).toHaveCount(0);
        await expect(article).not.toContainText(m.ai.demoTag);
        await captureState(page, testInfo, context, "private-on-care", ["qualified preview but private mode on: no 'Organise with AI' action", "0 /api/ai requests"], article);
        expect(shell.calls).toHaveLength(0);
        expect(requests).toEqual([]);

        await setKeepWordingOnDevice(page, m, false);
        const again = await openHistory(page, m);
        await again.click();
        const dialog = page.getByRole("dialog", { name: m.ai.remoteTitle });
        await expect(dialog).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await captureState(page, testInfo, context, "private-off-dialog-returns", ["setting off: the next explicit request shows the disclosure again", "only the credential-free passcode probe (GET, no body); no POST (nothing accepted)"], dialog);
        await dialog.getByRole("button", { name: m.ai.cancel }).click();
        expect(shell.calls).toHaveLength(0);
        // Setting off: the disclosure check asks the passcode probe (GET, no body) before the dialog; nothing else, and no POST.
        expect(requests.length).toBeGreaterThanOrEqual(1);
        expect(new Set(requests)).toEqual(new Set(["GET /api/ai/shell"]));
        expect(shell.probes.length).toBe(requests.length);
      });
    });
  }
}
