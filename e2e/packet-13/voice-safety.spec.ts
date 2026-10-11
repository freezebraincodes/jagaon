import { expect, test } from "@playwright/test";
import { LOCALES, REPORTED_AMOUNT, SCRIPTS, VIEWPORTS, countDelta, pending, recordCounts, savedText, speak, startPreparedProfile, startVoice, HARNESS_URL } from "./support";

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
      await expect(page.getByRole("button", { name: pending(locale).review.backToToday })).toBeVisible();
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

    // CR-11 (owner decisions 2026-10-11, design v3.1): case 11 now expects the number-and-unit confirmation (this replaces the 13s.3
    // out-of-range refusal test; the old case 11 evidence stays as evidence of the old behaviour).
    test("CR-11 case 11: 60 mmol asks for confirmation; Edit latch and Cancel write nothing; Save as shown saves 60.0 once (record-count audit)", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      const base = await recordCounts(page);
      await speak(page, m, SCRIPTS[locale].outOfRange);
      const card = page.getByRole("article").first();
      const panel = card.getByRole("region", { name: "60.0 mmol/L" });
      await expect(panel.getByRole("heading", { name: "60.0 mmol/L" })).toBeVisible();
      await expect(panel.getByText(copy.confirmBody)).toBeVisible();
      await expect(card.getByRole("button", { name: copy.save })).toHaveCount(0);
      // Cancel writes nothing; the card stays unsaved.
      await panel.getByRole("button", { name: copy.cancel }).click();
      await expect(card.getByText("60.0", { exact: true })).toBeVisible();
      expect(countDelta(base, await recordCounts(page))).toEqual({});
      // Edit to 45 still returns to the confirmation (the latch); Cancel again writes nothing.
      await card.getByRole("button", { name: copy.save }).click();
      await card.getByRole("region", { name: "60.0 mmol/L" }).getByRole("button", { name: copy.editReading }).click();
      await expect(card.getByLabel(copy.valueLabel)).toHaveValue("");
      await card.getByLabel(copy.valueLabel).fill("45");
      await card.getByRole("button", { name: copy.save }).click();
      const edited = card.getByRole("region", { name: "45.0 mmol/L" });
      await expect(edited.getByRole("heading", { name: "45.0 mmol/L" })).toBeFocused();
      await edited.getByRole("button", { name: copy.cancel }).click();
      expect(countDelta(base, await recordCounts(page))).toEqual({});
      // Save as shown (double press) writes exactly one reading, stored as 60.0.
      await card.getByRole("button", { name: copy.save }).click();
      const saveAsShown = card.getByRole("region", { name: "60.0 mmol/L" }).getByRole("button", { name: copy.saveAsShown });
      await saveAsShown.dblclick();
      await expect(card.getByRole("status")).toHaveText(copy.saved);
      await expect(card.getByText(copy.confirmBody)).toHaveCount(0);
      expect(countDelta(base, await recordCounts(page))).toEqual({ "recordRevisions.GLUCOSE_READING": 1, "recordHeads.GLUCOSE_READING": 1 });
      // Reload: the reading is there once, as 60.0 (time not recorded).
      await page.goto(HARNESS_URL);
      await expect(page.getByRole("button", { name: m.today.recordReading })).toBeVisible();
      await expect(page.locator(".booklet-unknown-time").getByText(new RegExp(`${m.glucose.valueLabel} 60\\.0 mmol/L`))).toHaveCount(1);
      expect(countDelta(base, await recordCounts(page))).toEqual({ "recordRevisions.GLUCOSE_READING": 1, "recordHeads.GLUCOSE_READING": 1 });
    });

    test("CR-11: spoken words and zero confirm the formatted value; an unstated unit needs the explicit Yes, mmol/L", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      await speak(page, m, SCRIPTS[locale].sixtyWords);
      await expect(page.getByRole("article").first().getByRole("region", { name: "60.0 mmol/L" })).toBeVisible();
      await speak(page, m, SCRIPTS[locale].zero);
      const zero = page.getByRole("article").first().getByRole("region", { name: "0.0 mmol/L" });
      await expect(zero.getByText(copy.confirmBody)).toBeVisible();
      await speak(page, m, SCRIPTS[locale].sixtyNoUnit);
      const unstated = page.getByRole("article").first().getByRole("region", { name: "60.0 mmol/L" });
      await expect(unstated.getByText(copy.unitAppDefault)).toHaveCount(0);
      await expect(unstated.getByRole("button", { name: copy.saveAsShown })).toBeDisabled();
      await unstated.getByLabel(copy.confirmUnit).check();
      await unstated.getByRole("button", { name: copy.saveAsShown }).click();
      await expect(page.getByRole("article").first().getByRole("status")).toHaveText(copy.saved);
    });

    test("CR-11 mixed: the meal saved first leaves the 60 card unsaved; confirming later saves only the reading", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      const base = await recordCounts(page);
      await speak(page, m, SCRIPTS[locale].mixedSixty);
      const [glucose, meal] = [page.getByRole("article").nth(0), page.getByRole("article").nth(1)];
      await meal.getByRole("button", { name: copy.save }).click();
      await expect(meal.getByRole("status")).toHaveText(copy.saved);
      await expect(glucose.getByText(copy.confirmBody)).toBeVisible();
      expect(countDelta(base, await recordCounts(page))).toEqual({ "recordRevisions.INTAKE_EVENT": 1, "recordHeads.INTAKE_EVENT": 1 });
      await glucose.getByRole("button", { name: copy.saveAsShown }).click();
      await expect(glucose.getByRole("status")).toHaveText(copy.saved);
      expect(countDelta(base, await recordCounts(page))).toEqual({ "recordRevisions.INTAKE_EVENT": 1, "recordHeads.INTAKE_EVENT": 1, "recordRevisions.GLUCOSE_READING": 1, "recordHeads.GLUCOSE_READING": 1 });
    });

    // CR-11 fix round 2 (owner rule 4): a reload WHILE a confirmation is open saves nothing (record-count audit).
    for (const [key, value] of [["outOfRange", "60.0"], ["zero", "0.0"]] as const) {
      test(`CR-11 reload while the voice confirmation for ${value} is open saves nothing`, async ({ page }) => {
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        const copy = pending(locale).card;
        const base = await recordCounts(page);
        await speak(page, m, SCRIPTS[locale][key]);
        const panel = page.getByRole("article").first().getByRole("region", { name: `${value} mmol/L` });
        await expect(panel.getByText(copy.confirmBody)).toBeVisible();
        expect(countDelta(base, await recordCounts(page))).toEqual({});
        await page.goto(HARNESS_URL);
        await expect(page.getByRole("button", { name: m.today.recordReading })).toBeVisible();
        await page.waitForTimeout(1_000);
        expect(countDelta(base, await recordCounts(page))).toEqual({});
        if (value === "60.0") await expect(page.getByText(/(?<![\d.])60\.0(?!\d)/)).toHaveCount(0);
      });
    }

    for (const [typed, value] of [["60", "60.0"], ["0", "0.0"]] as const) {
      test(`CR-11 reload while the manual confirmation for ${value} is open saves nothing; the entry screen does not save on return`, async ({ page }) => {
        const m = await startPreparedProfile(page, HARNESS_URL, locale);
        const base = await recordCounts(page);
        const valueField = () => page.getByRole("textbox", { name: new RegExp(`^${m.glucose.valueLabel}`) });
        await page.getByRole("button", { name: m.today.recordReading }).click();
        await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
        await page.getByRole("radio", { name: m.glucose.contextBeforeBreakfast }).check();
        await valueField().fill(typed);
        await page.getByRole("button", { name: m.glucose.saveAction }).click();
        const panel = page.getByRole("region", { name: `${value} ${m.glucose.unit}` });
        await expect(panel.getByText(m.glucose.confirmBody)).toBeVisible();
        expect(countDelta(base, await recordCounts(page))).toEqual({});
        await page.goto(HARNESS_URL);
        await expect(page.getByRole("button", { name: m.today.recordReading })).toBeVisible();
        await page.waitForTimeout(1_000);
        expect(countDelta(base, await recordCounts(page))).toEqual({});
        if (value === "60.0") await expect(page.getByText(/(?<![\d.])60\.0(?!\d)/)).toHaveCount(0);
        // Returning to the entry screen starts blank and saves nothing by itself.
        await page.getByRole("button", { name: m.today.recordReading }).click();
        await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
        await expect(valueField()).toHaveValue("");
        await expect(page.getByText(m.glucose.confirmBody)).toHaveCount(0);
        await page.waitForTimeout(1_000);
        expect(countDelta(base, await recordCounts(page))).toEqual({});
      });
    }

    // CR-11 round 2 addendum (owner): real-browser keyboard focus, operated by keyboard only, with the record-count audit.
    test("CR-11 keyboard focus, voice 60: panel heading on open, value input on Edit reading, Save this on Cancel, saved status on Save as shown", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const copy = pending(locale).card;
      const base = await recordCounts(page);
      await speak(page, m, SCRIPTS[locale].outOfRange);
      const card = page.getByRole("article").first();
      const saveThis = card.getByRole("button", { name: copy.save });
      // The panel is open on arrival; Cancel by keyboard first, so the person then opens it.
      await card.getByRole("region", { name: "60.0 mmol/L" }).getByRole("button", { name: copy.cancel }).press("Enter");
      await expect(saveThis).toBeFocused();
      // 1. Opened by the person: the panel heading is focused.
      await page.keyboard.press("Enter");
      await expect(card.getByRole("heading", { name: "60.0 mmol/L" })).toBeFocused();
      // 2. Edit reading: the value input is focused.
      await card.getByRole("button", { name: copy.editReading }).press("Enter");
      const value = card.getByLabel(copy.valueLabel);
      await expect(value).toBeFocused();
      await page.keyboard.type("45");
      await saveThis.press("Enter");
      await expect(card.getByRole("heading", { name: "45.0 mmol/L" })).toBeFocused();
      // 3. Cancel: the card's Save this is focused (never the body).
      await card.getByRole("button", { name: copy.cancel }).press("Enter");
      await expect(saveThis).toBeFocused();
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
      expect(countDelta(base, await recordCounts(page))).toEqual({});
      // 4. Reopen; Save as shown: the saved status line is focused.
      await page.keyboard.press("Enter");
      await expect(card.getByRole("heading", { name: "60.0 mmol/L" })).toBeFocused();
      await card.getByRole("button", { name: copy.saveAsShown }).press("Enter");
      await expect(card.getByRole("status")).toHaveText(copy.saved);
      await expect(card.getByRole("status")).toBeFocused();
      expect(countDelta(base, await recordCounts(page))).toEqual({ "recordRevisions.GLUCOSE_READING": 1, "recordHeads.GLUCOSE_READING": 1 });
    });

    test("CR-11 keyboard focus, manual 60: panel heading on Save, value input on Edit reading and on Cancel; Save as shown completes", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      const base = await recordCounts(page);
      await page.getByRole("button", { name: m.today.recordReading }).press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
      await page.getByRole("radio", { name: m.glucose.contextBeforeBreakfast }).press("Space");
      const value = page.getByRole("textbox", { name: new RegExp(`^${m.glucose.valueLabel}`) });
      await value.press("6");
      await value.press("0");
      // 1. Save: the panel heading is focused.
      await page.getByRole("button", { name: m.glucose.saveAction }).press("Enter");
      const heading = page.getByRole("heading", { name: `60.0 ${m.glucose.unit}` });
      await expect(heading).toBeFocused();
      // 2. Edit reading: the value input is focused.
      await page.getByRole("button", { name: m.glucose.editReading }).press("Enter");
      await expect(value).toBeFocused();
      // 3. Save again (Enter in the field submits the form); Cancel: the value input is focused.
      await page.keyboard.press("Enter");
      await expect(heading).toBeFocused();
      await page.getByRole("button", { name: m.glucose.cancelConfirm }).press("Enter");
      await expect(value).toBeFocused();
      expect(countDelta(base, await recordCounts(page))).toEqual({});
      // 4. Save as shown completes.
      await page.keyboard.press("Enter");
      await expect(heading).toBeFocused();
      await page.getByRole("button", { name: m.glucose.saveAsShown }).press("Enter");
      await expect(page.getByText(m.glucose.saved)).toBeVisible();
      expect(countDelta(base, await recordCounts(page))).toEqual({ "recordRevisions.GLUCOSE_READING": 1, "recordHeads.GLUCOSE_READING": 1 });
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
        // Finding N-1: the chooser opens the existing reading entry directly; Back to Today is a separate exit.
        await expect(page.getByRole("button", { name: pending(locale).review.backToToday })).toBeVisible();
        await page.getByRole("region", { name: pending(locale).review.manualHeading }).getByRole("button", { name: m.today.recordReading }).click();
        await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
      });
    }

    test("manual fallback from a card opens the existing glucose entry", async ({ page }) => {
      const m = await startPreparedProfile(page, HARNESS_URL, locale);
      await speak(page, m, SCRIPTS[locale].negated);
      await page.getByRole("article").first().getByRole("button", { name: pending(locale).card.manualGlucose }).click();
      await expect(page.getByRole("heading", { level: 1, name: m.today.recordReading })).toBeVisible();
    });
  });
}
