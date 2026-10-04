import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, expect, test, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";
import { createBackup, datasetFingerprint, evidenceShot, expectNoHorizontalOverflow, openDataBackup, PASSPHRASE, settledFingerprint, startPreparedProfile } from "./support";

/**
 * BAK-016 / RST-020 / RST-003 / RST-001: a synthetic backup written by each
 * declared engine restores through the other engine via the real UI. The
 * restored dataset's identity, heads and table counts match the source.
 * Fixture hashes are recorded for traceability; no plaintext is stored.
 */

const BASE = "http://localhost:3210";

async function open(engine: BrowserType): Promise<{ browser: Browser; page: Page }> {
  const browser = await engine.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(BASE);
  return { browser, page };
}

async function restoreInto(page: Page, file: string, engineName: string) {
  // A different, seeded lineage refuses the backup and changes nothing (RST-003).
  await startPreparedProfile(page);
  const seeded = await settledFingerprint(page);
  await openDataBackup(page);
  await page.getByRole("button", { name: "Restore from a backup" }).click();
  await page.getByLabel("Choose a .jagaon backup").setInputFiles(file);
  await page.getByLabel("Enter the backup passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Check this backup" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("This backup belongs to a different local dataset.");
  expect(await datasetFingerprint(page)).toEqual(seeded);
  await page.locator(".screen-back-button").click();

  // Delete all, restart setup on an empty dataset, then restore into it (RST-001).
  await page.getByRole("button", { name: "Delete all data on this device" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByRole("button", { name: "Delete everything on this device" }).click();
  await page.getByRole("button", { name: "Use the prepared demo profile" }).click();
  await openDataBackup(page);
  await page.getByRole("button", { name: "Restore from a backup" }).click();
  await page.getByLabel("Choose a .jagaon backup").setInputFiles(file);
  await page.getByLabel("Enter the backup passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Check this backup" }).click();
  await expect(page.getByText("This backup will restore a complete local dataset into this empty JagaOn.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await evidenceShot(page, engineName, "06-restore-plan-empty-en");
  await page.getByRole("button", { name: "Restore into this JagaOn" }).click();
  await expect(page.getByText("Restore complete on this device")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("The backup is restored. JagaOn is rebuilding the current view before you continue.")).toHaveCount(0);
  await evidenceShot(page, engineName, "08-restore-complete-en");
  await page.getByRole("button", { name: "Open Today" }).click();
  await expect(page.getByRole("button", { name: "Record a reading" })).toBeVisible();
  return datasetFingerprint(page);
}

test("BAK-016/RST-020: Chromium ⇄ WebKit synthetic backup round trips through the UI", async ({}, testInfo) => {
  const evidence: Record<string, unknown> = {};
  for (const [source, target] of [
    [chromium, webkit],
    [webkit, chromium],
  ] as const) {
    const exporter = await open(source);
    const sourceName = source.name();
    await startPreparedProfile(exporter.page);
    const sourceFingerprint = await settledFingerprint(exporter.page);
    await openDataBackup(exporter.page);
    const { path } = await createBackup(exporter.page);
    const bytes = readFileSync(path);
    const file = testInfo.outputPath(`${sourceName}.jagaon`);
    writeFileSync(file, bytes);
    const sourceVersion = exporter.browser.version();
    await exporter.browser.close();

    const importer = await open(target);
    const restored = await restoreInto(importer.page, file, `${target.name()}-from-${sourceName}`);
    const targetVersion = importer.browser.version();
    await importer.browser.close();

    expect(restored.identity).toBe(sourceFingerprint.identity);
    expect(restored.hash).toBe(sourceFingerprint.hash);
    // Canonical records match exactly; operational ledgers can only grow as
    // reconciliation completes restored pending responsibility (never a replay).
    for (const table of ["recordRevisions", "recordHeads", "deletionTombstones", "reverseDependencies"]) {
      expect(restored.counts[table], table).toBe(sourceFingerprint.counts[table]);
    }
    for (const table of ["auditEvents", "domainEvents", "commandReceipts", "eventWorkItems", "eventConsumerReceipts"]) {
      expect(restored.counts[table]!, table).toBeGreaterThanOrEqual(sourceFingerprint.counts[table]!);
    }
    evidence[`${sourceName}->${target.name()}`] = {
      sourceEngine: `${sourceName} ${sourceVersion}`,
      targetEngine: `${target.name()} ${targetVersion}`,
      syntheticFixtureSha256: createHash("sha256").update(bytes).digest("hex"),
      fixtureBytes: bytes.length,
      restoredHeads: restored.heads,
      headsFingerprintMatches: restored.hash === sourceFingerprint.hash,
    };
  }
  await testInfo.attach("cross-browser-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  writeFileSync(testInfo.outputPath("cross-browser-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
});
