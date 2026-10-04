import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createBackup, datasetFingerprint, evidenceShot, expectNoHorizontalOverflow, openDataBackup, PASSPHRASE, settledFingerprint, startPreparedProfile, withoutSavePicker } from "./support";

/**
 * Packet 10 real-browser evidence in each declared engine (Chromium, WebKit)
 * with real IndexedDB and Web Crypto on localhost. Synthetic data only.
 */

test.beforeEach(async ({ page }) => {
  await withoutSavePicker(page);
});

test("hub, create and delete-all layouts at 390 px, desktop and 200% in en-SG and zh-SG", async ({ page, browserName }) => {
  await startPreparedProfile(page);
  for (const [width, label] of [[390, "390"], [1280, "desktop"], [640, "desktop-200pct"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await openDataBackup(page);
    await expect(page.getByText("Records in this browser are not encrypted separately by JagaOn.", { exact: false })).toBeVisible();
    // The create action appears once the verified runtime is ready.
    await expect(page.getByRole("button", { name: "Create an encrypted backup" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await evidenceShot(page, browserName, `01-hub-en-${label}`);
    await page.getByRole("button", { name: "Create an encrypted backup" }).click();
    await page.getByLabel("Backup passphrase").fill("synthetic one");
    await page.getByLabel("Enter the same passphrase again").fill("synthetic two!");
    await page.getByLabel("Enter the same passphrase again").blur();
    await expect(page.locator("main").getByRole("alert")).toContainText("The two passphrases do not match. Nothing was created.");
    await expectNoHorizontalOverflow(page);
    await evidenceShot(page, browserName, `02-create-mismatch-en-${label}`);
    await page.locator(".screen-back-button").click();
    await page.locator(".screen-back-button").click();
  }
  // zh-SG: switch language in Settings (on More), then the hub renders the approved zh-SG rows.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole("button", { name: "简体中文" }).click();
  await openDataBackup(page, "资料与备份");
  await expect(page.getByRole("heading", { level: 1, name: "资料与备份" })).toBeVisible();
  await expect(page.getByRole("button", { name: "建立加密备份" })).toBeVisible();
  await expect(page.getByText("JagaOn 不会另外加密这个浏览器内的记录。", { exact: false })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await evidenceShot(page, browserName, "01-hub-zh-SG-390");
  await page.getByRole("button", { name: "删除这部装置上的所有资料" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "保留我的资料" })).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await evidenceShot(page, browserName, "11-delete-all-zh-SG-390");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "删除这部装置上的所有资料" })).toBeFocused();
});

test("BAK-013/015/017: offline export starts a download, sends nothing and logs nothing sensitive", async ({ page, context, browserName }) => {
  const console: string[] = [];
  page.on("console", (message) => console.push(message.text()));
  await startPreparedProfile(page);
  await openDataBackup(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await context.setOffline(true);
  const { fileName, path } = await createBackup(page);
  await context.setOffline(false);
  expect(fileName).toMatch(/^JagaOn-backup-\d{4}-\d{2}-\d{2}\.jagaon$/);
  expect(requests).toEqual([]);
  await expect(page.getByText("A started download does not prove the file was kept.", { exact: false })).toBeVisible();
  await expect(page.getByText("Your encrypted backup was saved to the location you chose.")).toHaveCount(0);
  await evidenceShot(page, browserName, "03-download-started-en");
  const text = readFileSync(path, "utf8");
  expect(text.startsWith('{"aadProfile":"JAGAON_BACKUP_HEADER_V1"')).toBe(true);
  expect(text).not.toContain(PASSPHRASE);
  expect(text).not.toContain("GLUCOSE_READING");
  for (const line of console) expect(line).not.toContain(PASSPHRASE);
  // No service worker or Cache Storage holds decrypted or dynamic content.
  const caches = await page.evaluate(async () => ({ workers: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0, caches: "caches" in window ? (await window.caches.keys()).length : 0 }));
  expect(caches).toEqual({ workers: 0, caches: 0 });
  // Local and session storage never hold the passphrase or plaintext.
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain(PASSPHRASE);
});

test("BAK-015: a confirmed file-write API is reported as saved", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => ({
      async createWritable() {
        return { write: async () => undefined, close: async () => undefined };
      },
    });
  });
  await startPreparedProfile(page);
  await openDataBackup(page);
  await page.getByRole("button", { name: "Create an encrypted backup" }).click();
  await page.getByLabel("Backup passphrase").fill(PASSPHRASE);
  await page.getByLabel("Enter the same passphrase again").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Prepare encrypted backup" }).click();
  await expect(page.getByText("Your encrypted backup was saved to the location you chose.")).toBeVisible();
  await expect(page.getByText("A started download does not prove the file was kept.", { exact: false })).toHaveCount(0);
});

test("BAK-011: a wrong passphrase and a changed file share one message and restore nothing", async ({ page, browserName }, testInfo) => {
  await startPreparedProfile(page);
  await openDataBackup(page);
  const { path } = await createBackup(page);
  const before = await settledFingerprint(page);
  await page.getByRole("button", { name: "Done" }).click();
  for (const [label, contents, passphrase] of [
    ["wrong-passphrase", readFileSync(path), "a completely different phrase"],
    ["changed-file", Buffer.from(readFileSync(path, "utf8").replace(/"ciphertext":"(.)/, (_, c) => `"ciphertext":"${c === "A" ? "B" : "A"}`)), PASSPHRASE],
  ] as const) {
    const file = testInfo.outputPath(`${label}.jagaon`);
    writeFileSync(file, contents);
    await page.getByRole("button", { name: "Restore from a backup" }).click();
    await page.getByLabel("Choose a .jagaon backup").setInputFiles(file);
    await page.getByLabel("Enter the backup passphrase").fill(passphrase);
    await page.getByRole("button", { name: "Check this backup" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("The passphrase is incorrect, or the backup is damaged or changed. Nothing was restored.");
    await expect(page.locator("main").getByRole("alert")).toContainText("JagaOn cannot tell which.");
    if (label === "wrong-passphrase") await evidenceShot(page, browserName, "05-auth-failure-en");
    await page.locator(".screen-back-button").click();
  }
  expect(await datasetFingerprint(page)).toEqual(before);
});

test("frame 10: permanent record deletion is an accessible alertdialog with focus return", async ({ page, browserName }) => {
  await startPreparedProfile(page);
  const opener = page.getByRole("button", { name: "Permanently delete record" });
  await opener.focus();
  await opener.press("Enter");
  const dialog = page.getByRole("alertdialog", { name: "Permanently delete this record?" });
  await expect(dialog.getByRole("button", { name: "Keep this record" })).toBeFocused();
  await expect(dialog.getByText("This record", { exact: true })).toBeVisible();
  await evidenceShot(page, browserName, "10-record-deletion-en");
  // Tab stays inside the dialog.
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  const before = await datasetFingerprint(page);
  await opener.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Permanently delete record" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const after = await datasetFingerprint(page);
  expect(after.counts.deletionTombstones).toBeGreaterThan(before.counts.deletionTombstones ?? 0);
  expect(after.counts.recordRevisions).toBeLessThan(before.counts.recordRevisions!);
});

test("SDEL-012: another open tab blocks delete-all; closing it lets delete-all complete and restart setup", async ({ page, context, browserName }) => {
  await startPreparedProfile(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("button", { name: "Record a reading" })).toBeVisible();
  await openDataBackup(page);
  const confirm = async () => {
    await page.getByRole("button", { name: "Delete all data on this device" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
    await dialog.getByRole("button", { name: "Delete everything on this device" }).click();
  };
  await confirm();
  await expect(page.locator("main").getByRole("alert")).toContainText("Another JagaOn tab is still open.");
  await expect(page.locator("main").getByRole("alert")).toContainText("Nothing was deleted.");
  await evidenceShot(page, browserName, "11-delete-all-blocked-en");
  expect((await datasetFingerprint(page)).heads).toBeGreaterThan(0);
  await other.close();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete everything on this device" }).click();
  await expect(page.getByText("Local data deleted. JagaOn will start setup again with a new local dataset.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to JagaOn" })).toBeVisible();
  const after = await datasetFingerprint(page);
  expect(after.heads).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("jagaon:demo-onboarding:v1"))).toBeNull();
});

test("RST-018: a launch that finds RESTORE_STATE RECONCILING resumes and completes before normal use", async ({ page }) => {
  await startPreparedProfile(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("jagaon");
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("storageMetadata", "readwrite");
          transaction.objectStore("storageMetadata").put({
            key: "RESTORE_STATE",
            phase: "RECONCILING",
            operationId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
            restoreMode: "REPLACE_SAME_LINEAGE_DATABASE",
            planHash: "a".repeat(64),
            committedAt: new Date().toISOString(),
            lastCompletedStep: "RECOVER_WORK_LEASES",
          });
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  await page.reload();
  // Today renders before the runtime is ready; wait for the durable checkpoint.
  const readState = () => page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const request = indexedDB.open("jagaon");
        request.onsuccess = () => {
          const get = request.result.transaction("storageMetadata").objectStore("storageMetadata").get("RESTORE_STATE");
          get.onsuccess = () => {
            request.result.close();
            resolve(get.result);
          };
        };
      }),
  );
  await expect.poll(readState, { timeout: 60_000 }).toMatchObject({ phase: "COMPLETED", lastCompletedStep: "CARE_SUMMARY_INVALIDATION" });
  await expect(page.getByRole("button", { name: "Record a reading" })).toBeEnabled();
});

test("Corrective Pass A item 3: a queued deletion blocked by an unknown connection cannot be cancelled and completes truthfully", async ({ page, browserName }) => {
  await startPreparedProfile(page);
  await openDataBackup(page);
  await expect(page.getByRole("button", { name: "Create an encrypted backup" })).toBeVisible();
  // An unknown connection (no Web Lock, never closes on versionchange) passes the presence preflight.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("jagaon");
        request.onsuccess = () => {
          (window as unknown as { __blocker: IDBDatabase }).__blocker = request.result;
          request.result.onversionchange = () => undefined;
          resolve();
        };
      }),
  );
  await page.getByRole("button", { name: "Delete all data on this device" }).click();
  await page.getByRole("alertdialog").getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete everything on this device" }).click();
  const blocker = page.getByRole("alertdialog", { name: "Delete all data on this device" });
  await expect(blocker).toHaveAttribute("aria-busy", "true");
  await expect(blocker.getByRole("alert")).toContainText("Another JagaOn tab is still open.");
  await evidenceShot(page, browserName, "11-delete-all-queued-waiting-en");
  // Every cancellation path is unavailable while the request is queued.
  await expect(blocker.getByRole("button")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(blocker).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep my data" })).toHaveCount(0);
  await expect(page.getByText("Nothing was deleted.")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __blocker: IDBDatabase }).__blocker.close());
  await expect(page.getByText("Local data deleted. JagaOn will start setup again with a new local dataset.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to JagaOn" })).toBeVisible();
  expect((await datasetFingerprint(page)).heads).toBe(0);
});

test("Corrective Pass A item 4: a tab whose delete-all or restore attempt was blocked stays visible to other tabs", async ({ page, context }) => {
  await startPreparedProfile(page);
  await openDataBackup(page);
  const { path } = await createBackup(page);
  await page.getByRole("button", { name: "Done" }).click();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("button", { name: "Record a reading" })).toBeEnabled();

  const deleteAllIn = async (tab: typeof page) => {
    await tab.getByRole("button", { name: "Delete all data on this device" }).click();
    const dialog = tab.getByRole("alertdialog");
    await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
    await dialog.getByRole("button", { name: "Delete everything on this device" }).click();
    await expect(tab.locator("main").getByRole("alert")).toContainText("Another JagaOn tab is still open.");
    await dialog.getByRole("button", { name: "Keep my data" }).click();
  };

  // A is blocked by B; B must then still be blocked by A.
  await deleteAllIn(page);
  await openDataBackup(other);
  await deleteAllIn(other);

  // A blocked restore attempt also keeps A visible.
  await page.getByRole("button", { name: "Restore from a backup" }).click();
  await page.getByLabel("Choose a .jagaon backup").setInputFiles(path);
  await page.getByLabel("Enter the backup passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Check this backup" }).click();
  await page.getByRole("button", { name: "Replace and restore" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace and restore" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Another JagaOn tab is blocking an update.");
  await deleteAllIn(other);
  expect((await datasetFingerprint(page)).heads).toBeGreaterThan(0);
});
