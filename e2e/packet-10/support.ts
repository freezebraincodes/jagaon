import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

/** Synthetic-only helpers for Packet 10 browser evidence. No real data or secrets. */

export const PASSPHRASE = "synthetic demo passphrase 晚安";
export const EVIDENCE_DIR = join(process.cwd(), "internal-docs/mockups/hackathon-evidence/packet-10");

export async function startPreparedProfile(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Use the prepared demo profile" }).click();
  await expect(page.getByRole("button", { name: "Record a reading" })).toBeVisible();
}

export async function openDataBackup(page: Page, label = "Data and backup"): Promise<void> {
  await page.locator(".app-nav").getByRole("button").last().click();
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

export async function evidenceShot(page: Page, engine: string, name: string): Promise<void> {
  const dir = join(EVIDENCE_DIR, engine);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** A content-free fingerprint of the stored dataset: identity, heads and table counts. */
export async function datasetFingerprint(page: Page): Promise<{ identity: string; heads: number; hash: string; counts: Record<string, number> }> {
  const summary = await page.evaluate(
    () =>
      new Promise<{ identity: string; heads: string[]; counts: Record<string, number> }>((resolve, reject) => {
        // H1 rehearsal (WebKit, intermittent): right after delete-all the app may not have created its new database yet. Opening
        // it then CREATED an empty v1 database and `transaction([])` threw inside onsuccess, so the promise never settled (180 s
        // timeout). An absent database is now reported as empty, without creating one (the upgrade is aborted).
        let absent = false;
        const request = indexedDB.open("jagaon");
        request.onupgradeneeded = () => {
          absent = true;
          request.transaction?.abort();
        };
        request.onerror = () => (absent ? resolve({ identity: "", heads: [], counts: {} }) : reject(request.error));
        request.onsuccess = () => {
          const database = request.result;
          const names = [...database.objectStoreNames];
          if (names.length === 0) {
            database.close();
            resolve({ identity: "", heads: [], counts: {} });
            return;
          }
          const transaction = database.transaction(names, "readonly");
          const counts: Record<string, number> = {};
          let heads: string[] = [];
          let identity = "";
          for (const name of names) {
            const all = transaction.objectStore(name).getAll();
            all.onsuccess = () => {
              const rows = all.result as Array<Record<string, unknown>>;
              counts[name] = rows.length;
              if (name === "recordHeads") heads = rows.map((row) => `${row.recordId}|${row.headRevisionId}|${row.state}`).sort();
              if (name === "storageMetadata") identity = String(rows.find((row) => row.key === "DATABASE_IDENTITY")?.datasetIdentity ?? "");
            };
          }
          transaction.oncomplete = () => {
            database.close();
            resolve({ identity, heads, counts });
          };
        };
      }),
  );
  return { identity: summary.identity, heads: summary.heads.length, hash: createHash("sha256").update(summary.heads.join("\n")).digest("hex"), counts: summary.counts };
}

export async function createBackup(page: Page): Promise<{ fileName: string; path: string }> {
  await page.getByRole("button", { name: "Create an encrypted backup" }).click();
  await page.getByLabel("Backup passphrase").fill(PASSPHRASE);
  await page.getByLabel("Enter the same passphrase again").fill(PASSPHRASE);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Prepare encrypted backup" }).click();
  const file = await download;
  const path = await file.path();
  await expect(page.getByText("Your encrypted backup was prepared and the download started.", { exact: false })).toBeVisible();
  return { fileName: file.suggestedFilename(), path: path! };
}

/** Make Chromium use the ordinary download path (its native save picker cannot be automated). */
export async function withoutSavePicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
}

/** Waits until background owner work has settled: two reads one second apart agree. */
export async function settledFingerprint(page: Page): Promise<Awaited<ReturnType<typeof datasetFingerprint>>> {
  let previous = await datasetFingerprint(page);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(1000);
    const next = await datasetFingerprint(page);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  throw new Error("dataset did not settle");
}
