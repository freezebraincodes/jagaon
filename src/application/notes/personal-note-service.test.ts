// @vitest-environment node
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserJournalRuntime, type JagaOnRuntime } from "@/application/journal/browser-journal-runtime";
import { installFakeIndexedDb, openRaw, readAllTables } from "@/application/storage/packet10-test-support";
import type { PersonalNotePayload } from "@/domain/notes/personal-note";
import type { Instant } from "@/domain/shared";

/**
 * Owner decision 2026-10-14 (My notes): the PERSONAL_NOTE record through the real browser runtime (authoritative store, permanent
 * deletion, demo reset). Synthetic notes only.
 */
installFakeIndexedDb();
const TIMEOUT = 240_000;
const names: string[] = [];
const runtimes: JagaOnRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = "2026-10-14T02:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString() as Instant;

function note(overrides: Partial<PersonalNotePayload> = {}): PersonalNotePayload {
  return { text: "Slept badly again (synthetic).", language: "en-SG", feelingCues: ["tired"], turns: [], themes: ["SLEEP"], aiUsed: false, promptVersion: null, careQuestionRef: null, ...overrides };
}

async function open() {
  const name = `notes-${crypto.randomUUID()}`;
  names.push(name);
  const clock = { now: NOW as Instant };
  const runtime = await createBrowserJournalRuntime(name, { now: () => clock.now, seedSyntheticScenarioOnCreate: false });
  runtimes.push(runtime);
  return { name, runtime, notes: runtime.notes!, clock };
}

describe("personal notes (PERSONAL_NOTE)", () => {
  it(
    "saves a note in one transaction with a closed-reason event and audit, and lists it",
    async () => {
      const { name, runtime, notes } = await open();
      expect(Object.keys(runtime.notes!)).toEqual(["commands", "query"]);
      expect(Object.keys(notes.commands)).toEqual(["createPersonalNote"]);
      expect(Object.keys(notes.query)).toEqual(["listPersonalNotes", "themeCounts"]);

      const saved = await notes.commands.createPersonalNote({ payload: note({ text: "  Slept badly again (synthetic).  ", feelingCues: ["tired", "tired"], themes: ["SLEEP", "SLEEP", "MOOD"] }) });
      expect(saved).toMatchObject({ kind: "COMMITTED" });
      if (saved.kind !== "COMMITTED") return;
      const list = await notes.query.listPersonalNotes();
      expect(list).toEqual([
        { recordId: saved.recordId, revisionId: saved.revisionId, recordedAt: NOW, payload: note({ feelingCues: ["tired"], themes: ["SLEEP", "MOOD"] }) },
      ]);

      const database = await openRaw(name);
      const rows = await readAllTables(database);
      database.close();
      expect(rows.recordHeads).toEqual([expect.objectContaining({ recordId: saved.recordId, recordType: "PERSONAL_NOTE", state: "ACTIVE" })]);
      expect(rows.domainEvents).toEqual([expect.objectContaining({ eventName: "PERSONAL_NOTE_RECORDED", payload: { reasonCode: "PATIENT_SAVED_NOTE" } })]);
      expect(rows.auditEvents).toEqual([expect.objectContaining({ recordType: "PERSONAL_NOTE", action: "CREATE", initiator: "PATIENT", assistance: "NONE", reasonCode: "PATIENT_SAVED_NOTE" })]);
      // The note text lives only in its revision: never in an event, an audit or a receipt.
      for (const table of ["domainEvents", "auditEvents", "commandReceipts", "eventWorkItems"] as const) expect(JSON.stringify(rows[table])).not.toContain("Slept badly");
    },
    TIMEOUT,
  );

  it(
    "records AI assistance and a care-question reference exactly as approved",
    async () => {
      const { name, runtime, notes } = await open();
      const question = await runtime.careOrganisation.commands.createCareQuestion({ questionText: { text: "Is poor sleep worth mentioning? (demo)", language: "en-SG" } });
      expect(question.kind).toBe("COMMITTED");
      if (question.kind !== "COMMITTED") return;
      const careQuestionRef = { recordType: "CARE_QUESTION" as const, recordId: question.recordId, revisionId: question.revisionId };
      const payload = note({
        aiUsed: true,
        promptVersion: "feelings-chat.1",
        careQuestionRef,
        turns: [
          { role: "PATIENT", text: "I could not sleep.", source: "PATIENT" },
          { role: "JAGAON_QUESTION", text: "What kept you awake?", source: "AI_VALIDATED" },
        ],
      });
      const saved = await notes.commands.createPersonalNote({ payload });
      expect(saved.kind).toBe("COMMITTED");
      expect((await notes.query.listPersonalNotes())[0]?.payload).toEqual(payload);
      const database = await openRaw(name);
      const audits = (await database.table("auditEvents").toArray()).filter((row: { recordType: string }) => row.recordType === "PERSONAL_NOTE");
      const revisions = (await database.table("recordRevisions").toArray()).filter((row: { recordType: string }) => row.recordType === "PERSONAL_NOTE");
      database.close();
      expect(audits).toEqual([expect.objectContaining({ assistance: "AI_ASSISTED" })]);
      expect(revisions).toEqual([expect.objectContaining({ revision: expect.objectContaining({ provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "AI_ASSISTED" } }) })]);
    },
    TIMEOUT,
  );

  it(
    "refuses an invalid note and writes nothing",
    async () => {
      const { name, notes } = await open();
      const snapshot = await openRaw(name);
      const before = JSON.stringify(await readAllTables(snapshot));
      snapshot.close();
      for (const payload of [note({ text: "" }), note({ aiUsed: true, promptVersion: null }), note({ themes: ["STRESS" as never] }), { text: "no other fields" } as never, undefined as never]) {
        expect(await notes.commands.createPersonalNote({ payload })).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
      }
      expect(await notes.commands.createPersonalNote({ payload: note(), commandId: "not-a-uuid" })).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
      const database = await openRaw(name);
      expect(JSON.stringify(await readAllTables(database))).toBe(before);
      database.close();
    },
    TIMEOUT,
  );

  it(
    "makes a retried command idempotent and refuses the same command id with another note",
    async () => {
      const { notes } = await open();
      const commandId = crypto.randomUUID();
      const first = await notes.commands.createPersonalNote({ payload: note(), commandId });
      expect(first.kind).toBe("COMMITTED");
      expect(await notes.commands.createPersonalNote({ payload: note(), commandId })).toEqual(first);
      expect(await notes.commands.createPersonalNote({ payload: note({ text: "Another note (synthetic)." }), commandId })).toEqual({ kind: "FAILED", code: "COMMIT_FAILED" });
      expect(await notes.query.listPersonalNotes()).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "lists newest first and counts this week's themes (notes older than seven days are left out)",
    async () => {
      const { notes, clock } = await open();
      const save = async (when: Instant, payload: PersonalNotePayload) => {
        clock.now = when;
        const result = await notes.commands.createPersonalNote({ payload });
        expect(result.kind).toBe("COMMITTED");
      };
      await save(at(-8 * DAY), note({ text: "Old note (synthetic).", themes: ["WORK", "SLEEP"] }));
      await save(at(-6 * DAY), note({ text: "Six days ago (synthetic).", themes: ["SLEEP", "FAMILY"] }));
      await save(at(-2 * DAY), note({ text: "Two days ago (synthetic).", themes: ["SLEEP", "MONEY"] }));
      await save(at(-1 * DAY), note({ text: "Yesterday (synthetic).", themes: ["FAMILY", "SLEEP"] }));
      await save(at(-60_000), note({ text: "Just now (synthetic).", themes: [] }));
      clock.now = NOW as Instant;

      expect((await notes.query.listPersonalNotes()).map((entry) => entry.payload.text)).toEqual([
        "Just now (synthetic).",
        "Yesterday (synthetic).",
        "Two days ago (synthetic).",
        "Six days ago (synthetic).",
        "Old note (synthetic).",
      ]);
      expect(await notes.query.themeCounts({ now: NOW, days: 7 })).toEqual([
        { theme: "SLEEP", count: 3 },
        { theme: "FAMILY", count: 2 },
        { theme: "MONEY", count: 1 },
      ]);
      // Default window is seven days; a narrower window counts fewer notes.
      expect(await notes.query.themeCounts({ now: NOW })).toEqual(await notes.query.themeCounts({ now: NOW, days: 7 }));
      expect(await notes.query.themeCounts({ now: NOW, days: 1.5 })).toEqual([
        { theme: "FAMILY", count: 1 },
        { theme: "SLEEP", count: 1 },
      ]);
      expect(await notes.query.themeCounts({ now: at(-30 * DAY), days: 7 })).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "deletes one note through the existing permanent deletion, leaving no note text behind",
    async () => {
      const { name, runtime, notes } = await open();
      const kept = await notes.commands.createPersonalNote({ payload: note({ text: "Keep this one (synthetic)." }) });
      const removed = await notes.commands.createPersonalNote({ payload: note({ text: "Remove this one (synthetic)." }) });
      if (kept.kind !== "COMMITTED" || removed.kind !== "COMMITTED") throw new Error("setup failed");

      const prepared = await runtime.recordDeletion.prepare({ recordType: "PERSONAL_NOTE", recordId: removed.recordId });
      expect(prepared.kind).toBe("PLAN_READY");
      if (prepared.kind !== "PLAN_READY") return;
      expect(prepared.plan.effects.dependentCount).toBe(0);
      expect(await runtime.recordDeletion.confirm(prepared.plan, { planHash: prepared.plan.planHash, confirmedAt: NOW as Instant })).toMatchObject({ kind: "DELETED" });

      expect((await notes.query.listPersonalNotes()).map((entry) => entry.recordId)).toEqual([kept.recordId]);
      const database = await openRaw(name);
      const rows = await readAllTables(database);
      database.close();
      expect(JSON.stringify(rows)).not.toContain("Remove this one");
      expect(rows.deletionTombstones).toEqual([expect.objectContaining({ recordId: removed.recordId, recordType: "PERSONAL_NOTE", initiator: "PATIENT" })]);
    },
    TIMEOUT,
  );

  it(
    "clears notes with the demo reset",
    async () => {
      const { notes, runtime } = await open();
      expect((await notes.commands.createPersonalNote({ payload: note() })).kind).toBe("COMMITTED");
      await runtime.resetDemo();
      expect(await notes.query.listPersonalNotes()).toEqual([]);
      expect(await notes.query.themeCounts({ now: NOW })).toEqual([]);
    },
    TIMEOUT,
  );
});
