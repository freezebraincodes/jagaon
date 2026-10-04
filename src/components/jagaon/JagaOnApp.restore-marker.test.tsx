import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime, type BrowserJournalRuntimeOptions } from "@/application/journal/browser-journal-runtime";
import { APPOINTMENT_NOTE_SELECTION_KEY } from "@/application/history/appointment-note-selection";
import { createDemoOnboardingRepository, createMemoryOnboardingStorage, DEMO_ONBOARDING_STORAGE_KEY, type DemoOnboardingStoragePort } from "@/application/onboarding/demo-onboarding-repository";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import { createRestoreService } from "@/application/restore/restore-service";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { getMessages } from "@/i18n/get-messages";
import { JagaOnApp } from "./JagaOnApp";

/**
 * Packet 10 Corrective Pass D, end to end through the real restore service,
 * restore transaction, reconciliation and runtime: an integrity-screen style
 * restore made while local cleanup is pending never lets stale setup return.
 */

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-04T03:00:00.000Z";
const REQUESTED = "2026-10-01T08:00:00.000Z";
const en = getMessages("en-SG");
const names: string[] = [];
afterEach(async () => {
  cleanup();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function ownerStorage(initial: Record<string, string>, failing: boolean) {
  const memory = createMemoryOnboardingStorage(initial);
  const state = { failing, removeAttempts: 0 };
  const port: DemoOnboardingStoragePort = {
    getItem: (key) => memory.getItem(key),
    setItem: (key, value) => memory.setItem(key, value),
    removeItem: (key) => {
      state.removeAttempts += 1;
      if (state.failing) throw new Error("storage unavailable");
      memory.removeItem(key);
    },
  };
  return { port, state };
}

async function marker(name: string) {
  const database = await openRaw(name);
  const row = await database.table("storageMetadata").get("LOCAL_STATE_CLEANUP_PENDING");
  database.close();
  return row ?? null;
}

/** A populated backup restored into the pending replacement dataset through the real service. */
async function restoredWhilePending(): Promise<string> {
  const { name: source, runtime } = await createPopulatedDataset();
  names.push(source);
  runtime.close();
  const database = await openRaw(source);
  const capture = capturingFilePort();
  await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
  database.close();

  const target = `restore-marker-shell-${crypto.randomUUID()}`;
  names.push(target);
  (await createBrowserJournalRuntime(target, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false, localStateCleanup: { requestedAt: REQUESTED as never, when: "IF_CREATED" } })).close();
  const service = createRestoreService({
    databaseName: target,
    now: () => LATER as never,
    crypto: () => createWebCryptoPort(),
    coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
    closeRuntime: () => undefined,
  });
  const inspected = await service.inspect(capture.saved[0]!.bytes, PASS);
  if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
  expect((await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).kind).toBe("COMMITTED");
  return target;
}

function mount(target: string, onboarding: ReturnType<typeof ownerStorage>, notes: ReturnType<typeof ownerStorage>) {
  const seen = { today: false };
  const observer = new MutationObserver(() => {
    if (screen.queryByRole("button", { name: en.today.recordReading })) seen.today = true;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  render(
    <JagaOnApp
      runtimeFactory={(_name?: string, options?: BrowserJournalRuntimeOptions) => createBrowserJournalRuntime(target, { ...options, now: () => LATER as never })}
      onboardingRepositoryFactory={() => createDemoOnboardingRepository(onboarding.port)}
      appointmentNoteStorageFactory={() => notes.port}
    />,
  );
  return { seen, stop: () => observer.disconnect() };
}

async function expectFreshSetupOnly(seen: { today: boolean }) {
  expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle }, { timeout: 30_000 })).toBeInTheDocument();
  expect(seen.today).toBe(false);
  expect(screen.queryByRole("button", { name: en.today.recordReading })).toBeNull();
  expect(screen.queryByText(en.packet10.deletion.deleteAllDone)).toBeNull();
}

describe("restore while local cleanup is pending (Corrective Pass D)", () => {
  it(
    "A/B: the restored dataset keeps the marker across full remounts until every owner confirms, and stale setup never returns",
    async () => {
      const target = await restoredWhilePending();
      const prepared = createPreparedOnboardingState("en-SG", PACKET10_NOW);
      const onboarding = ownerStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }, true);
      const notes = ownerStorage({ [APPOINTMENT_NOTE_SELECTION_KEY]: JSON.stringify({ schemaVersion: 1, selections: [] }) }, false);

      // A: first launch after the restore (reconciliation runs), then a full remount; cleanup keeps failing.
      for (let launch = 0; launch < 2; launch += 1) {
        const before = { onboarding: onboarding.state.removeAttempts, notes: notes.state.removeAttempts };
        const app = mount(target, onboarding, notes);
        await expectFreshSetupOnly(app.seen);
        // Every owner is retried on every launch; the failing one keeps the marker.
        await waitFor(() => expect(onboarding.state.removeAttempts).toBeGreaterThan(before.onboarding));
        expect(notes.state.removeAttempts).toBeGreaterThan(before.notes);
        app.stop();
        cleanup();
        expect(await marker(target)).toEqual({ key: "LOCAL_STATE_CLEANUP_PENDING", requestedAt: REQUESTED });
      }
      expect(onboarding.port.getItem(DEMO_ONBOARDING_STORAGE_KEY)).not.toBeNull();

      // B: cleanup now works; the marker goes only once both owners confirm.
      onboarding.state.failing = false;
      notes.port.setItem(APPOINTMENT_NOTE_SELECTION_KEY, JSON.stringify({ schemaVersion: 1, selections: [] }));
      const app = mount(target, onboarding, notes);
      expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle }, { timeout: 30_000 })).toBeInTheDocument();
      await waitFor(async () => expect(await marker(target)).toBeNull(), { timeout: 30_000 });
      expect(onboarding.port.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull();
      expect(notes.port.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).toBeNull();
      expect(app.seen.today).toBe(false);
      app.stop();
      cleanup();

      // A further remount never brings the stale profile back.
      const again = mount(target, onboarding, notes);
      await expectFreshSetupOnly(again.seen);
      again.stop();
    },
    TIMEOUT,
  );
});
