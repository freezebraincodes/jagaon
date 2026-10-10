import { expect, test } from "@playwright/test";
import { LOCALES, REPORTED_AMOUNT, SCRIPTS, VIEWPORTS, pending, savedText, speak, startPreparedProfile, startVoice, HARNESS_URL } from "./support";

/** Packet 13 safety set (owner): values/units, ambiguity, negation, unsupported speech, redirects, cancellation, failure, manual fallback. */
for (const locale of LOCALES) {
  test.describe(`safety ${locale} @390`, () => {
    test.use({ viewport: VIEWPORTS.mobile.viewport, deviceScaleFactor: VIEWPORTS.mobile.deviceScaleFactor });

    test("values and units: a unit from the app setting is labelled as such; no unit selector anywhere", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      await speak(page, m, SCRIPTS[locale].noUnit);
      await expect(page.getByText(copy.unitAppDefault)).toBeVisible();
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await page.getByRole("article").getByRole("button", { name: copy.save }).click();
      await expect(page.getByText(savedText(locale))).toBeVisible();
      // A spoken unsupported unit is never relabelled: not understood, manual entry offered.
      await speak(page, m, SCRIPTS[locale].otherUnit);
      await expect(page.getByRole("article")).toHaveCount(0);
      await expect(page.getByRole("button", { name: m.voice.disclosure.decline }).first()).toBeVisible();
    });

    for (const key of ["negated", "comparison"] as const) {
      test(`ambiguity (${key}): never saved as proposed; the edit field is empty`, async ({ page }) => {
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        const copy = pending(locale).card;
        await speak(page, m, SCRIPTS[locale][key]);
        const card = page.getByRole("article").first();
        await expect(card.getByText(copy.needsEdit)).toBeVisible();
        await expect(card.getByRole("button", { name: copy.save })).toBeDisabled();
        await card.getByRole("button", { name: copy.edit }).click();
        await expect(card.getByLabel(copy.valueLabel)).toHaveValue("");
      });
    }

    test("another person's reading is never saved here", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      await speak(page, m, SCRIPTS[locale].otherPerson);
      await expect(page.getByText(pending(locale).card.otherPerson)).toBeVisible();
      await expect(page.getByRole("article").getByRole("button", { name: pending(locale).card.save })).toHaveCount(0);
    });

    test("unsupported speech is listed as not understood, never dropped; the reading beside it must be typed (round 4)", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      await speak(page, m, SCRIPTS[locale].unsupported);
      await expect(page.getByText(pending(locale).review.notUnderstoodHeading)).toBeVisible();
      await expect(page.getByText(pending(locale).review.notUnderstoodBody)).toBeVisible();
      const card = page.getByRole("article").first();
      await expect(card.getByText(copy.needsEdit)).toBeVisible();
      await expect(card.getByRole("button", { name: copy.save })).toBeDisabled();
      await card.getByRole("button", { name: copy.edit }).click();
      await expect(card.getByLabel(copy.valueLabel)).toHaveValue("");
    });

    test("13s.3: a health question shows the health wording (chosen by category), never the dose wording", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      await speak(page, m, SCRIPTS[locale].health);
      await expect(page.getByText(pending(locale).redirect.healthBody).first()).toBeVisible();
      await expect(page.getByText(m.voice.redirect.body)).toHaveCount(0);
      await expect(page.getByText(m.voice.redirect.transcribedNote)).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(0);
    });

    test("13s.3: an out-of-range value is explained in plain words, never one-tap saved, with the manual path", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      await speak(page, m, SCRIPTS[locale].outOfRange);
      const card = page.getByRole("article").first();
      await expect(card.getByText(copy.outOfRange)).toBeVisible();
      await expect(card.getByRole("button", { name: copy.save })).toBeDisabled();
      await card.getByRole("button", { name: copy.edit }).click();
      await expect(card.getByLabel(copy.valueLabel)).toHaveValue("");
      await card.getByLabel(copy.valueLabel).fill("60");
      await card.getByRole("button", { name: copy.save }).click();
      await expect(card.getByRole("status")).toHaveText(copy.outOfRange);
      await card.getByRole("button", { name: m.voice.disclosure.decline }).click();
      await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
    });

    test("13s.3: a reported amount is shown as said; the card says plainly whether it will be saved", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      await speak(page, m, SCRIPTS[locale].amountTaken);
      await expect(page.getByText(copy.amountReported(REPORTED_AMOUNT[locale]))).toBeVisible();
      await expect(page.getByText(copy.amountWillBeSaved)).toBeVisible();
      await speak(page, m, SCRIPTS[locale].amountSkipped);
      await expect(page.getByText(copy.amountReported(REPORTED_AMOUNT[locale]))).toBeVisible();
      await expect(page.getByText(copy.amountNotSaved)).toBeVisible();
      await expect(page.getByText(copy.amountWillBeSaved)).toHaveCount(0);
    });

    test("a dose question shows only the fixed redirect; a mixed utterance keeps the reading as its own card", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      await speak(page, m, SCRIPTS[locale].dose);
      await expect(page.getByText(m.voice.redirect.body).first()).toBeVisible();
      await expect(page.getByText(m.voice.redirect.transcribedNote)).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(0);
      await speak(page, m, SCRIPTS[locale].mixed);
      await expect(page.getByText(m.voice.redirect.body)).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(1);
    });

    test("cancellation: nothing is saved", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      await startVoice(page, m, {});
      await expect(page.getByRole("button", { name: m.voice.state.stop })).toBeEnabled();
      await page.getByRole("button", { name: m.voice.state.cancel }).click();
      await expect(page.getByRole("status").filter({ hasText: m.voice.state.cancelled })).toBeVisible();
    });

    for (const [fail, text] of [["PERMISSION_DENIED", "permissionDenied"], ["PROVIDER_FAILURE", "unavailable"], ["UNSUPPORTED_BROWSER", "unsupported"]] as const) {
      test(`failure ${fail}: plain explanation and manual fallback to the glucose entry`, async ({ page }) => {
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        await startVoice(page, m, { fail });
        await expect(page.getByRole("status").filter({ hasText: m.voice.state[text] })).toBeVisible();
        await page.getByRole("button", { name: m.voice.disclosure.decline }).click();
        await expect(page.getByRole("button", { name: m.today.recordReading })).toBeVisible();
      });
    }

    test("manual fallback from a card opens the existing glucose entry", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      await speak(page, m, SCRIPTS[locale].negated);
      await page.getByRole("article").first().getByRole("button", { name: m.voice.disclosure.decline }).click();
      await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
    });
  });
}
