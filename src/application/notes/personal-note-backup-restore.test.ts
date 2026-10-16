// @vitest-environment jsdom
// The jsdom environment is deliberate: it is the environment of every existing backup and restore test (Web Crypto key wrapping fails
// under the plain node environment with fake IndexedDB). Synthetic data only.
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createRestoreService } from "@/application/restore/restore-service";
import { installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import type { PersonalNotePayload } from "@/domain/notes/personal-note";

/** Owner decision 2026-10-14 (My notes): PERSONAL_NOTE rows round-trip through the existing backup export and restore (no format change). */
installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-05T03:00:00.000Z";
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});
const uuid = () => crypto.randomUUID();

describe("personal notes through backup and restore", () => {
  it(
    "round-trips through backup export and restore (closed codecs validate the rows)",
    async () => {
      const source = `notes-source-${uuid()}`;
      names.push(source);
      const runtime = await createBrowserJournalRuntime(source, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false });
      const question = await runtime.careOrganisation.commands.createCareQuestion({ questionText: { text: "Is poor sleep worth mentioning? (demo)", language: "en-SG" } });
      if (question.kind !== "COMMITTED") throw new Error("setup failed");
      const payload: PersonalNotePayload = {
        text: "Slept badly; worried about the pen (synthetic).",
        language: "en-SG",
        feelingCues: ["tired", "worried"],
        turns: [
          { role: "PATIENT", text: "I could not sleep.", source: "PATIENT" },
          { role: "JAGAON_QUESTION", text: "What kept you awake?", source: "AI_VALIDATED" },
          { role: "JAGAON_KIND_SENTENCE", text: "That sounds tiring.", source: "REVIEWED_BANK" },
        ],
        themes: ["SLEEP", "MEDICINES"],
        aiUsed: true,
        promptVersion: "feelings-chat.1",
        careQuestionRef: { recordType: "CARE_QUESTION", recordId: question.recordId, revisionId: question.revisionId },
      };
      const saved = await runtime.notes!.commands.createPersonalNote({ payload });
      expect(saved.kind).toBe("COMMITTED");

      const database = await openRaw(source);
      const capture = capturingFilePort();
      const exported = await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
      expect(exported.kind).toBe("DOWNLOAD_STARTED");
      database.close();
      runtime.close();

      const target = `notes-target-${uuid()}`;
      names.push(target);
      (await createBrowserJournalRuntime(target, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false })).close();
      const restore = createRestoreService({ databaseName: target, now: () => LATER as never, crypto: () => createWebCryptoPort(), coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined }, closeRuntime: vi.fn() });
      const inspected = await restore.inspect(capture.saved[0]!.bytes, PASS);
      expect(inspected.kind).toBe("PLAN_READY");
      if (inspected.kind !== "PLAN_READY") return;
      expect(await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      const restored = await createBrowserJournalRuntime(target, { now: () => LATER as never });
      expect(await restored.notes!.query.listPersonalNotes()).toEqual([{ recordId: saved.kind === "COMMITTED" ? saved.recordId : null, revisionId: saved.kind === "COMMITTED" ? saved.revisionId : null, recordedAt: PACKET10_NOW, payload }]);
      expect(await restored.notes!.query.themeCounts({ now: LATER })).toEqual([
        { theme: "MEDICINES", count: 1 },
        { theme: "SLEEP", count: 1 },
      ]);
      restored.close();
    },
    TIMEOUT,
  );
});
