import { expect, test } from "@playwright/test";
import { LOCALES, PRODUCTION_URL, VIEWPORTS, pending, startPreparedProfile } from "./support";

/**
 * Voice off, on the PRODUCTION build with no voice environment (clean copy): "Tell JagaOn" stays visible; opening it explains at once
 * that voice is unavailable and offers manual entry (review I-5: the credential-free availability probe answers { available: false }
 * before anything else). No disclosure and no passcode prompt, no microphone permission (getUserMedia is never called), no UserSig
 * request (no POST to the credential route), no TRTC session (no request to a Tencent host). Nothing simulated.
 */
const TENCENT = /rtc-web|qcloud|tencent|trtc|my-imcloud|yun\.tim\.qq\.com/i;

for (const locale of LOCALES) {
  test.describe(`voice off ${locale} @390`, () => {
    test.use({ viewport: VIEWPORTS.mobile.viewport, deviceScaleFactor: VIEWPORTS.mobile.deviceScaleFactor });

    test("unavailable with manual entry at once; no disclosure, passcode, microphone, UserSig or TRTC session", async ({ page }) => {
      await page.addInitScript(() => {
        const calls = { getUserMedia: 0 };
        (window as unknown as { __p13: typeof calls }).__p13 = calls;
        const devices = navigator.mediaDevices;
        if (devices?.getUserMedia) {
          const original = devices.getUserMedia.bind(devices);
          devices.getUserMedia = (constraints) => {
            calls.getUserMedia += 1;
            return original(constraints);
          };
        }
      });
      const tencent: string[] = [];
      const credential: Array<{ method: string; status: number; body: string }> = [];
      page.on("request", (request) => {
        if (TENCENT.test(new URL(request.url()).hostname)) tencent.push(request.url());
      });
      page.on("response", async (response) => {
        if (new URL(response.url()).pathname === "/api/voice/usersig") credential.push({ method: response.request().method(), status: response.status(), body: await response.text() });
      });
      const m = await startPreparedProfile(page, PRODUCTION_URL, locale);
      await page.getByRole("button", { name: m.voice.entry }).click();
      await expect(page.getByRole("status").filter({ hasText: m.voice.state.unavailable })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByLabel(m.aiAccess.passcodeLabel)).toHaveCount(0);
      await expect(page.getByText(m.voice.disclosure.title)).toHaveCount(0);
      expect(credential).toEqual([{ method: "GET", status: 200, body: JSON.stringify({ available: false }) }]);
      expect(await page.evaluate(() => (window as unknown as { __p13: { getUserMedia: number } }).__p13.getUserMedia)).toBe(0);
      expect(tencent).toEqual([]);
      await expect(page.getByRole("article")).toHaveCount(0);
      // Finding N-1: the chooser opens the existing reading entry directly; Back to Today is a separate exit.
      await page.getByRole("region", { name: pending(locale).review.manualHeading }).getByRole("button", { name: m.today.recordReading }).click();
      await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
    });
  });
}
