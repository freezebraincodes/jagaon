// @vitest-environment node
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { analyseTranscript, normaliseVoicePhrase } from "@/domain/voice/voice-candidate-extractor";
import { isRememberableTerminologyPhrase, PATIENT_TERMINOLOGY_CONTENT_VERSION } from "@/domain/terminology/patient-terminology";
import type { RecordHead } from "@/domain/shared";
import type { JagaOnDatabase } from "@/storage/database";
import { patientTerminologyRevisionCodec } from "./terminology-persistence";
import { createTerminologyService, type TerminologyService } from "./terminology-service";

/**
 * P13S step 3: the PATIENT_TERMINOLOGY record through the real authoritative store, permanent deletion, backup export and restore.
 * Synthetic data only (the populated demo dataset's medicines).
 */
installFakeIndexedDb();
const TIMEOUT = 240_000;
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

const uuid = () => crypto.randomUUID();
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid } as never;

async function dataset() {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  const database = await openRaw(name);
  const service = createTerminologyService(database, { now: () => PACKET10_NOW, ids, deletion: runtime.recordDeletion });
  const medicines = await service.activeMedicines();
  expect(medicines.length).toBeGreaterThanOrEqual(2);
  return { name, runtime, database, service, first: medicines[0]!.medication, second: medicines[1]!.medication };
}

const directoryAnalysis = async (service: TerminologyService, text: string, language: "en" | "zh" = "en") => analyseTranscript(text, language, { medicines: await service.directory(language) });
const json = async (database: JagaOnDatabase) => JSON.stringify(await readAllTables(database));

describe("patient terminology record (PATIENT_TERMINOLOGY)", () => {
  it(
    "remember → reuse (also after a reload) → change → forget, with no journal event and no phrase left behind",
    async () => {
      const { name, runtime, database, service, first, second } = await dataset();
      const medicationEventsBefore = (await database.table("recordRevisions").toArray()).filter((row: { recordType: string }) => row.recordType === "MEDICATION_EVENT").length;

      const remembered = await service.remember({ language: "en", phrase: "  Dark   PEN ", medication: first });
      expect(remembered).toMatchObject({ kind: "COMMITTED" });
      expect(await service.list()).toEqual([expect.objectContaining({ language: "en", phrase: "dark pen", revisionNumber: 1, medication: first })]);
      expect(await directoryAnalysis(service, "I injected my dark pen")).toMatchObject({ candidates: [{ kind: "MEDICATION_OCCURRENCE", medicineRef: { kind: "MAPPED", via: "TERMINOLOGY", medication: first } }] });
      expect(await directoryAnalysis(service, "I injected my grey pen")).toMatchObject({ candidates: [{ medicineRef: { kind: "UNRESOLVED", phrase: "grey pen" } }] });

      // Remembering never records a journal event; the domain event and audit carry a closed reason only.
      const rows = await readAllTables(database);
      expect(rows.recordRevisions.filter((row) => (row as { recordType: string }).recordType === "MEDICATION_EVENT")).toHaveLength(medicationEventsBefore);
      expect(JSON.stringify(rows.domainEvents)).not.toContain("dark pen");
      expect(JSON.stringify(rows.auditEvents)).not.toContain("dark pen");
      expect(rows.domainEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventName: "PATIENT_TERM_REMEMBERED", payload: { reasonCode: "PATIENT_REMEMBERED_TERM" } })]));

      // Reload: a fresh service on a reopened database reuses the term with no repeat question.
      database.close();
      runtime.close();
      const reopened = await openRaw(name);
      const runtime2 = await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW });
      const service2 = createTerminologyService(reopened, { now: () => PACKET10_NOW, ids, deletion: runtime2.recordDeletion });
      expect(await directoryAnalysis(service2, "I injected my dark pen")).toMatchObject({ candidates: [{ medicineRef: { kind: "MAPPED", via: "TERMINOLOGY", medication: first } }] });

      // Same mapping again: no change. Same phrase, another medicine: a CORRECT revision of the same record.
      expect(await service2.remember({ language: "en", phrase: "dark pen", medication: first })).toMatchObject({ kind: "NO_CHANGE" });
      const [term] = await service2.list();
      expect(await service2.change({ recordId: term!.recordId, expectedRevisionId: "00000000-0000-4000-8000-000000000000" as never, medication: second })).toEqual({ kind: "REJECTED", code: "HEAD_CONFLICT" });
      expect(await service2.change({ recordId: term!.recordId, expectedRevisionId: term!.revisionId, medication: second })).toMatchObject({ kind: "COMMITTED" });
      expect(await service2.list()).toEqual([expect.objectContaining({ phrase: "dark pen", revisionNumber: 2, medication: second })]);
      expect(await directoryAnalysis(service2, "I injected my dark pen")).toMatchObject({ candidates: [{ medicineRef: { medication: second } }] });

      // Forget: the existing patient permanent deletion; no revision keeps the phrase.
      expect(await service2.forget({ recordId: term!.recordId })).toEqual({ kind: "FORGOTTEN" });
      expect(await service2.list()).toEqual([]);
      expect(await directoryAnalysis(service2, "I injected my dark pen")).toMatchObject({ candidates: [{ medicineRef: { kind: "UNRESOLVED" } }] });
      expect(await json(reopened)).not.toContain("dark pen");
      expect((await reopened.table("deletionTombstones").toArray()).some((row: { recordId: string }) => row.recordId === term!.recordId)).toBe(true);
      reopened.close();
      runtime2.close();
    },
    TIMEOUT,
  );

  it(
    "never maps to an inactive medicine; a removed canonical medicine makes the term dormant (never reused)",
    async () => {
      const { runtime, database, service, first } = await dataset();
      expect(await service.remember({ language: "zh", phrase: "黑色的笔", medication: first })).toMatchObject({ kind: "COMMITTED" });
      expect(await service.remember({ language: "en", phrase: "pen", medication: { ...first, recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4b01" } })).toEqual({ kind: "REJECTED", code: "MEDICINE_NOT_ACTIVE" });

      // Reuse resolves to the medicine's CURRENT head revision.
      const head = (await database.table("recordHeads").get(first.recordId)) as RecordHead;
      expect(await directoryAnalysis(service, "我打了黑色的笔", "zh")).toMatchObject({ candidates: [{ medicineRef: { kind: "MAPPED", via: "TERMINOLOGY", medication: { recordId: first.recordId, revisionId: head.headRevisionId } } }] });

      // Canonical-record removal (simulated on the head in this test only; no Care Plan deletion is enabled in this profile): the term
      // is dormant, never reused, and the medicine is no longer a known medicine for a save intent.
      await database.table("recordHeads").put({ ...head, state: "DELETED" });
      expect(await service.list()).toEqual([expect.objectContaining({ phrase: "黑色的笔", medication: null })]);
      expect((await service.directory("zh")).terms).toEqual([]);
      expect(await directoryAnalysis(service, "我打了黑色的笔", "zh")).toMatchObject({ candidates: [{ medicineRef: { kind: "UNRESOLVED" } }] });
      expect((await service.knownMedications()).some((ref) => ref.recordId === first.recordId)).toBe(false);
      database.close();
      runtime.close();
    },
    TIMEOUT,
  );

  it("the revision codec refuses unnormalised phrases, non-patient provenance, extra fields and other meanings", () => {
    const base = {
      schemaVersion: 1,
      recordType: "PATIENT_TERMINOLOGY",
      recordId: uuid(),
      revisionId: uuid(),
      revisionNumber: 1,
      previousRevisionId: null,
      action: "CREATE",
      recordedAt: PACKET10_NOW,
      revisionCreatedAt: PACKET10_NOW,
      temporal: { kind: "ATEMPORAL" },
      provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" },
      auditEventId: uuid(),
      transactionId: uuid(),
      payload: { contentVersion: "patient-terminology.13s.1", language: "en", phrase: "dark pen", meaning: { kind: "MEDICATION", medication: { recordType: "MEDICATION", recordId: uuid(), revisionId: uuid() } }, confirmation: "PATIENT_CONFIRMED" },
    };
    expect(() => patientTerminologyRevisionCodec.create(base as never)).not.toThrow();
    const refused = [
      { ...base, payload: { ...base.payload, phrase: "Dark Pen" } },
      { ...base, payload: { ...base.payload, phrase: "x".repeat(33) } },
      // Terminology review #2: no digit, number word, amount, unit or time word (EN and ZH).
      ...["10 units", "dark pen 10", "two pens", "dark pen units", "pen 5mg", "white tablet", "night pen", "morning pen", "pen at 8 am", "pen pm"].map((phrase) => ({ ...base, payload: { ...base.payload, phrase } })),
      ...["十个单位", "黑色的笔两支", "白色药片", "早上的笔", "八点的笔", "晚上那支", "睡前的药"].map((phrase) => ({ ...base, payload: { ...base.payload, language: "zh", phrase } })),
      { ...base, payload: { ...base.payload, transcript: "I injected my dark pen" } },
      { ...base, payload: { ...base.payload, meaning: { kind: "DOSE", amount: "10 units" } } },
      { ...base, payload: { ...base.payload, confirmation: "INFERRED" } },
      { ...base, provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "AI_EXTRACTION", initiator: "JAGAON_SYSTEM", assistance: "NONE" } },
      { ...base, action: "CORRECT" },
      { ...base, schemaVersion: 2 },
    ];
    for (const value of refused) expect(() => patientTerminologyRevisionCodec.create(value as never), JSON.stringify(value).slice(0, 80)).toThrow();
  });

  it("terminology review #2: only a short word phrase can be remembered (no digit, number, amount, unit or time word)", () => {
    for (const [phrase, language] of [["dark pen", "en"], ["grey pen", "en"], ["the blue inhaler", "en"], ["黑色的笔", "zh"], ["那支灰色的笔", "zh"], ["lantus笔", "zh"]] as const) {
      expect(isRememberableTerminologyPhrase(phrase, language), phrase).toBe(true);
    }
    for (const [phrase, language] of [["10 units", "en"], ["one pen", "en"], ["5 mg pen", "en"], ["pen mg", "en"], ["capsule", "en"], ["night pen", "en"], ["pen 8 pm", "en"], ["x".repeat(33), "en"], ["个单位", "zh"], ["片", "zh"], ["八点", "zh"], ["早上的笔", "zh"], ["pm的笔", "zh"], ["十", "zh"]] as const) {
      expect(isRememberableTerminologyPhrase(phrase, language), phrase).toBe(false);
    }
  });

  it("review #7: the normal form the record relies on is pinned (a change to it needs a new record content version)", () => {
    expect(PATIENT_TERMINOLOGY_CONTENT_VERSION).toBe("patient-terminology.13s.1");
    const pinned: Array<[string, "en" | "zh", string]> = [
      ["  Dark   Pen ", "en", "dark pen"],
      ["Grey\tPEN", "en", "grey pen"],
      ["Mum\u2019s pen", "en", "mum's pen"],
      ["Cafe\u0301 pen", "en", "caf\u00e9 pen"],
      [" 黑色 的 笔 ", "zh", "黑色的笔"],
      ["灰色\u3000的笔", "zh", "灰色的笔"],
    ];
    for (const [input, language, normal] of pinned) expect(normaliseVoicePhrase(input, language), input).toBe(normal);
  });

  it(
    "review #5: a stored term that fails its integrity check is rethrown by remember and change, never reported as an ordinary failure; #4: remember corrects, never duplicates",
    async () => {
      const { runtime, database, service, first, second } = await dataset();
      expect(await service.remember({ language: "en", phrase: "dark pen", medication: first })).toMatchObject({ kind: "COMMITTED" });
      expect(await service.remember({ language: "en", phrase: "Dark Pen", medication: second })).toMatchObject({ kind: "COMMITTED" });
      expect(await service.list()).toEqual([expect.objectContaining({ phrase: "dark pen", revisionNumber: 2, medication: second })]);
      const [term] = await service.list();
      const raw = (await database.table("recordRevisions").get(term!.revisionId)) as { payload: Record<string, unknown> };
      await database.table("recordRevisions").put({ ...raw, payload: { ...raw.payload, phrase: "Not Normalised" } });
      await expect(service.remember({ language: "en", phrase: "grey pen", medication: first })).rejects.toMatchObject({ name: "StorageRowValidationError", code: "STORAGE_INTEGRITY_FAILED" });
      await expect(service.change({ recordId: term!.recordId, expectedRevisionId: term!.revisionId, medication: first })).rejects.toMatchObject({ name: "StorageRowValidationError", code: "STORAGE_INTEGRITY_FAILED" });
      database.close();
      runtime.close();
    },
    TIMEOUT,
  );
});
