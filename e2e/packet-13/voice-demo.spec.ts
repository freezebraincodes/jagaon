import { expect, test } from "@playwright/test";
import { DARK_PEN, LOCALES, SCRIPTS, VIEWPORTS, expectNoHorizontalOverflow, openTab, pending, savedText, speak, startPreparedProfile, HARNESS_URL } from "./support";

/**
 * Packet 13 demo interactions (owner): TRTC transcription (scripted fake here) → multi-fact extraction → unknown-term clarification →
 * explicit remembering → per-fact review and confirmation → existing journal saves → terminology reuse
 * after a reload. EN and ZH at 390 px.
 */
for (const locale of LOCALES) {
  test.describe(`demo @smoke ${locale} @390`, () => {
    test.use({ viewport: VIEWPORTS.mobile.viewport, deviceScaleFactor: VIEWPORTS.mobile.deviceScaleFactor });

    test("demo 1: one utterance → three separate facts; 'dark pen' clarified and remembered separately; each fact confirmed on its own", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      // Finding T-1: the booklet's stamped count before the voice save (the synthetic seed may already stamp known-time readings today).
      const bookletProgress = page.locator(".booklet-progress");
      const progressBefore = await bookletProgress.textContent();
      await speak(page, m, SCRIPTS[locale].demo);
      const cards = page.getByRole("article");
      await expect(cards).toHaveCount(3);
      await expect(page.getByText(m.voice.review.transcriptLabel)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await cards.nth(0).getByRole("button", { name: copy.save }).click();
      await expect(cards.nth(0).getByText(savedText(locale))).toBeVisible();
      await cards.nth(1).getByRole("button", { name: copy.save }).click();
      await expect(cards.nth(1).getByText(savedText(locale))).toBeVisible();
      // Clarify the unknown phrase: pick a medicine from the prepared profile, tick "remember" (a separate decision), confirm.
      await expect(cards.nth(2).getByRole("button", { name: copy.save })).toBeDisabled();
      await cards.nth(2).getByRole("button", { name: copy.chooseMedicine }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(DARK_PEN[locale]);
      await dialog.getByRole("radio").first().check();
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: copy.chooseMedicine }).click();
      await expect(cards.nth(2).getByText(copy.remembered)).toBeVisible();
      await cards.nth(2).getByRole("button", { name: copy.save }).click();
      await expect(cards.nth(2).getByText(savedText(locale))).toBeVisible();

      // Finding T-1: the spoken reading has no time, so Today lists it as "Time not recorded · Entered at …", not in a Morning/Afternoon/
      // Evening slot, and the stamped count does not change; the medicine event is labelled the same way. Checked again after a reload.
      const unknownTime = `${m.today.timeNotRecorded} · ${m.today.enteredAt("")}`;
      for (const step of ["after save", "after reload"] as const) {
        if (step === "after save") await openTab(page, m.shared.navToday);
        else await page.reload();
        const listed = page.locator(".booklet-unknown-time li");
        await expect(listed, step).toHaveCount(1);
        await expect(listed, step).toContainText(`${m.glucose.valueLabel} 6.8`);
        await expect(listed, step).toContainText(unknownTime);
        await expect(page.locator(".booklet-slots"), step).not.toContainText(unknownTime);
        await expect(bookletProgress, step).toHaveText(progressBefore ?? "");
        await expect(page.locator(".insulin-list"), step).toContainText(unknownTime);
      }
    });

    test("demo 2: after a reload the remembered term is reused with no question; the fact still needs its own Save", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      await speak(page, m, SCRIPTS[locale].demo);
      const first = page.getByRole("article").nth(2);
      await first.getByRole("button", { name: copy.chooseMedicine }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("radio").first().check();
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: copy.chooseMedicine }).click();
      await expect(first.getByText(copy.remembered)).toBeVisible();
      await page.reload();
      await speak(page, m, SCRIPTS[locale].darkPenAgain);
      const card = page.getByRole("article");
      await expect(card).toHaveCount(1);
      await expect(card.getByRole("button", { name: copy.chooseMedicine })).toHaveCount(0);
      await expect(card.getByRole("button", { name: copy.save })).toBeEnabled();
      // Terminology review Critical #1: forget the remembered word from the screen's own section; the question then returns.
      await page.getByText(pending(locale).terms.heading).click();
      await page.getByRole("button", { name: `${pending(locale).terms.forget} “${DARK_PEN[locale]}”` }).click();
      const forget = page.getByRole("dialog");
      await expect(forget).toContainText(pending(locale).terms.forgetTitle);
      await forget.getByRole("button", { name: pending(locale).terms.forgetConfirm }).click();
      await expect(page.getByText(pending(locale).terms.forgotten)).toBeVisible();
      await speak(page, m, SCRIPTS[locale].darkPenAgain);
      await expect(page.getByRole("article").getByRole("button", { name: copy.chooseMedicine })).toBeVisible();
      // 'grey pen' is not remembered: asked again; a planned dose is never an event.
      await speak(page, m, SCRIPTS[locale].greyPen);
      await expect(page.getByText(copy.planned)).toBeVisible();
      await expect(page.getByRole("article").getByRole("button", { name: copy.save })).toBeDisabled();
    });
  });
}
