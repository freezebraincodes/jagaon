import { z } from "zod";
import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import { fingerprint } from "@/application/intelligence/metrics";
import { CARE_PLAN_STORED_ROW_CODECS } from "@/application/care-plan/care-plan-persistence";
import type { PermanentDeletionService } from "@/application/deletion/permanent-deletion-service";
import { OwnerPlanError } from "@/application/owner-plan-support";
import type { AuditEventId, Instant, RecordHead, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import { normaliseVoicePhrase, type VoiceMedicineDirectory } from "@/domain/voice/voice-candidate-extractor";
import type { VoiceMedicationRef } from "@/domain/voice/voice-contracts";
import {
  PATIENT_TERMINOLOGY_CONTENT_VERSION,
  PATIENT_TERMINOLOGY_RECORD_TYPE,
  PATIENT_TERMINOLOGY_SCHEMA_VERSION,
  patientTerminologyPayloadSchema,
  type PatientTerminologyRevision,
  type TerminologyLanguage,
} from "@/domain/terminology/patient-terminology";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import type { JagaOnDatabase } from "@/storage/database";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { buildTerminologyCommitPlan, createTerminologyCommandStore, patientTerminologyRevisionCodec } from "./terminology-persistence";

/**
 * Packet 13 (P13S step 3): the patient-terminology service (ask → confirm → remember → reuse).
 * - `remember` (explicit): phrase → an ACTIVE canonical medicine; a new phrase creates a record, the same phrase in the same language
 *   with another medicine corrects it, the same mapping is NO_CHANGE. It records no journal event.
 * - `change` (explicit): a new medicine for an existing term, with the expected head (stale edits are rejected).
 * - `forget` (explicit): the existing patient permanent deletion (prepare, then confirm the reviewed plan): no phrase remains.
 * - `directory(language)`: the extractor's data: remembered terms resolved to their medicine's CURRENT active head (a term whose
 *   medicine is no longer active is dormant and never reused), and the active medicines' exact names. Read on every analysis, so a
 *   reload reuses what was remembered.
 * - `knownMedications()`: the profile's current active canonical medicines (the only medicines a save intent may name).
 */
export type TerminologyDependencies = Readonly<{
  now(): Instant;
  ids: Readonly<{
    commandId(): CommandId;
    correlationId(): CorrelationId;
    recordId(): RecordId;
    revisionId(): RevisionId;
    auditEventId(): AuditEventId;
    transactionId(): TransactionId;
    domainEventId(): DomainEventId;
  }>;
  deletion: PermanentDeletionService;
}>;

export type TerminologyCommitResult =
  | Readonly<{ kind: "COMMITTED"; recordId: RecordId; revisionId: RevisionId }>
  | Readonly<{ kind: "NO_CHANGE"; recordId: RecordId; revisionId: RevisionId }>
  | Readonly<{ kind: "REJECTED"; code: "HEAD_CONFLICT" | "MEDICINE_NOT_ACTIVE" | "TERM_NOT_FOUND" }>
  | Readonly<{ kind: "FAILED"; code: "VALIDATION_FAILED" | "STORAGE_UNAVAILABLE" | "COMMIT_FAILED" }>;

export type TerminologyForgetResult = Readonly<{ kind: "FORGOTTEN" }> | Readonly<{ kind: "REFUSED" | "FAILED"; code: string }>;

export type RememberedTerm = Readonly<{
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  language: TerminologyLanguage;
  phrase: string;
  /** The medicine's current active head, or null when the medicine is no longer active (the term is dormant). */
  medication: VoiceMedicationRef | null;
}>;

export type ActiveMedicine = Readonly<{ medication: VoiceMedicationRef; names: readonly string[] }>;

export type TerminologyService = Readonly<{
  remember(input: Readonly<{ language: TerminologyLanguage; phrase: string; medication: VoiceMedicationRef }>): Promise<TerminologyCommitResult>;
  change(input: Readonly<{ recordId: RecordId; expectedRevisionId: RevisionId; medication: VoiceMedicationRef }>): Promise<TerminologyCommitResult>;
  forget(input: Readonly<{ recordId: RecordId }>): Promise<TerminologyForgetResult>;
  list(): Promise<readonly RememberedTerm[]>;
  activeMedicines(): Promise<readonly ActiveMedicine[]>;
  knownMedications(): Promise<readonly VoiceMedicationRef[]>;
  directory(language: TerminologyLanguage): Promise<VoiceMedicineDirectory>;
}>;

/**
 * Terminology review #5: a stored row that fails its read-time integrity check (or a transaction that reports an integrity failure) is
 * never turned into an ordinary FAILED result here; it is rethrown, as the journal and the other owner services surface integrity
 * failures, so the app's integrity gate sees it.
 */
function rethrowIntegrity(error: unknown): void {
  if (error instanceof StorageRowValidationError && error.code === "STORAGE_INTEGRITY_FAILED") throw error;
  if (error instanceof CommandTransactionError && error.code === "STORAGE_INTEGRITY_FAILED") throw error;
}

const PATIENT_ENTRY = Object.freeze({ sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" } as const);
const refOf = (head: RecordHead): VoiceMedicationRef => ({ recordType: "MEDICATION", recordId: head.recordId, revisionId: head.headRevisionId });

export function createTerminologyService(database: JagaOnDatabase, dependencies: TerminologyDependencies): TerminologyService {
  const store = createTerminologyCommandStore(database);
  const { ids } = dependencies;

  async function heads(): Promise<RecordHead[]> {
    return (await database.table("recordHeads").toArray()) as RecordHead[];
  }

  async function activeMedicines(): Promise<readonly ActiveMedicine[]> {
    const medicineHeads = (await heads()).filter((head) => head.recordType === "MEDICATION" && head.state === "ACTIVE");
    const medicines: ActiveMedicine[] = [];
    for (const head of medicineHeads) {
      const raw = await database.table("recordRevisions").get(head.headRevisionId);
      if (raw === undefined) continue;
      const stored = CARE_PLAN_STORED_ROW_CODECS.revision.validateAfterRead(raw) as { revision: { recordType: string; payload: { identity?: { patientEnteredName?: string; matchedLabel?: string } } } };
      if (stored.revision.recordType !== "MEDICATION") continue;
      const identity = stored.revision.payload.identity ?? {};
      const names = [identity.patientEnteredName, identity.matchedLabel].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
      medicines.push(Object.freeze({ medication: refOf(head), names: Object.freeze([...new Set(names)]) }));
    }
    return Object.freeze(medicines);
  }

  async function activeMedicineHead(recordId: string): Promise<RecordHead | null> {
    const head = ((await database.table("recordHeads").get(recordId)) as RecordHead | undefined) ?? null;
    return head && head.recordType === "MEDICATION" && head.state === "ACTIVE" ? head : null;
  }

  async function termRevisions(): Promise<Array<{ head: RecordHead; revision: PatientTerminologyRevision }>> {
    const termHeads = (await heads()).filter((head) => head.recordType === PATIENT_TERMINOLOGY_RECORD_TYPE && head.state === "ACTIVE");
    const rows: Array<{ head: RecordHead; revision: PatientTerminologyRevision }> = [];
    for (const head of termHeads) {
      const raw = await database.table("recordRevisions").get(head.headRevisionId);
      if (raw === undefined) continue;
      rows.push({ head, revision: patientTerminologyRevisionCodec.validateAfterRead(raw).revision as PatientTerminologyRevision });
    }
    return rows;
  }

  async function commit(commandName: string, revision: PatientTerminologyRevision, expectedHead: RecordHead | null, now: Instant): Promise<TerminologyCommitResult> {
    try {
      const plan = buildTerminologyCommitPlan({
        commandId: ids.commandId(),
        commandHash: fingerprint({ commandName, recordId: revision.recordId, payload: revision.payload, previous: revision.previousRevisionId }),
        correlationId: ids.correlationId(),
        transactionId: revision.transactionId,
        completedAt: now,
        revision,
        expectedHead,
        eventId: ids.domainEventId(),
      });
      const receipt = await store.execute(plan);
      if (receipt.outcome === "COMMITTED") return Object.freeze({ kind: "COMMITTED", recordId: revision.recordId, revisionId: revision.revisionId });
      if (receipt.outcome === "REJECTED") return Object.freeze({ kind: "REJECTED", code: "HEAD_CONFLICT" });
      return Object.freeze({ kind: "FAILED", code: "COMMIT_FAILED" });
    } catch (error) {
      rethrowIntegrity(error);
      if (error instanceof OwnerPlanError || error instanceof z.ZodError || error instanceof StorageRowValidationError) return Object.freeze({ kind: "FAILED", code: "VALIDATION_FAILED" });
      if (error instanceof CommandTransactionError && error.code === "COMMAND_REPLAY_MISMATCH") return Object.freeze({ kind: "FAILED", code: "COMMIT_FAILED" });
      return Object.freeze({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" });
    }
  }

  function revisionFor(input: { recordId: RecordId; revisionNumber: number; previousRevisionId: RevisionId | null; language: TerminologyLanguage; phrase: string; medication: VoiceMedicationRef; now: Instant }): PatientTerminologyRevision {
    const payload = patientTerminologyPayloadSchema.parse({
      contentVersion: PATIENT_TERMINOLOGY_CONTENT_VERSION,
      language: input.language,
      phrase: input.phrase,
      meaning: { kind: "MEDICATION", medication: { recordType: "MEDICATION", recordId: input.medication.recordId, revisionId: input.medication.revisionId } },
      confirmation: "PATIENT_CONFIRMED",
    });
    return {
      schemaVersion: PATIENT_TERMINOLOGY_SCHEMA_VERSION,
      recordType: PATIENT_TERMINOLOGY_RECORD_TYPE,
      recordId: input.recordId,
      revisionId: ids.revisionId(),
      revisionNumber: input.revisionNumber,
      previousRevisionId: input.previousRevisionId,
      action: input.previousRevisionId === null ? "CREATE" : "CORRECT",
      recordedAt: input.now,
      revisionCreatedAt: input.now,
      temporal: { kind: "ATEMPORAL" },
      provenance: PATIENT_ENTRY,
      auditEventId: ids.auditEventId(),
      transactionId: ids.transactionId(),
      payload,
    } as PatientTerminologyRevision;
  }

  async function remember(input: Readonly<{ language: TerminologyLanguage; phrase: string; medication: VoiceMedicationRef }>): Promise<TerminologyCommitResult> {
    try {
      const now = dependencies.now();
      const phrase = normaliseVoicePhrase(typeof input.phrase === "string" ? input.phrase : "", input.language);
      const medicine = await activeMedicineHead(input.medication?.recordId);
      if (!medicine) return Object.freeze({ kind: "REJECTED", code: "MEDICINE_NOT_ACTIVE" });
      const medication = refOf(medicine);
      const existing = (await termRevisions()).find((row) => row.revision.payload.language === input.language && row.revision.payload.phrase === phrase);
      if (existing) {
        if (existing.revision.payload.meaning.medication.recordId === medication.recordId) return Object.freeze({ kind: "NO_CHANGE", recordId: existing.head.recordId, revisionId: existing.head.headRevisionId });
        return commit("CHANGE_PATIENT_TERM", revisionFor({ recordId: existing.head.recordId, revisionNumber: existing.head.headRevisionNumber + 1, previousRevisionId: existing.head.headRevisionId, language: input.language, phrase, medication, now }), existing.head, now);
      }
      return commit("REMEMBER_PATIENT_TERM", revisionFor({ recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, language: input.language, phrase, medication, now }), null, now);
    } catch (error) {
      rethrowIntegrity(error);
      if (error instanceof z.ZodError || error instanceof StorageRowValidationError) return Object.freeze({ kind: "FAILED", code: "VALIDATION_FAILED" });
      return Object.freeze({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" });
    }
  }

  async function change(input: Readonly<{ recordId: RecordId; expectedRevisionId: RevisionId; medication: VoiceMedicationRef }>): Promise<TerminologyCommitResult> {
    try {
      const now = dependencies.now();
      const current = (await termRevisions()).find((row) => row.head.recordId === input.recordId);
      if (!current) return Object.freeze({ kind: "REJECTED", code: "TERM_NOT_FOUND" });
      if (current.head.headRevisionId !== input.expectedRevisionId) return Object.freeze({ kind: "REJECTED", code: "HEAD_CONFLICT" });
      const medicine = await activeMedicineHead(input.medication?.recordId);
      if (!medicine) return Object.freeze({ kind: "REJECTED", code: "MEDICINE_NOT_ACTIVE" });
      const medication = refOf(medicine);
      if (current.revision.payload.meaning.medication.recordId === medication.recordId) return Object.freeze({ kind: "NO_CHANGE", recordId: current.head.recordId, revisionId: current.head.headRevisionId });
      const { language, phrase } = current.revision.payload;
      return commit("CHANGE_PATIENT_TERM", revisionFor({ recordId: current.head.recordId, revisionNumber: current.head.headRevisionNumber + 1, previousRevisionId: current.head.headRevisionId, language, phrase, medication, now }), current.head, now);
    } catch (error) {
      rethrowIntegrity(error);
      if (error instanceof z.ZodError || error instanceof StorageRowValidationError) return Object.freeze({ kind: "FAILED", code: "VALIDATION_FAILED" });
      return Object.freeze({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" });
    }
  }

  async function forget(input: Readonly<{ recordId: RecordId }>): Promise<TerminologyForgetResult> {
    try {
      const prepared = await dependencies.deletion.prepare({ recordType: PATIENT_TERMINOLOGY_RECORD_TYPE, recordId: input.recordId });
      if (prepared.kind === "REFUSED") return Object.freeze({ kind: "REFUSED", code: prepared.reason });
      if (prepared.kind !== "PLAN_READY") return Object.freeze({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" });
      // The forget action itself is the patient's explicit confirmation of this one-record plan (no other record is in it).
      if (prepared.plan.closure.dependents.length !== 0) return Object.freeze({ kind: "REFUSED", code: "UNSUPPORTED_DEPENDENT" });
      const confirmed = await dependencies.deletion.confirm(prepared.plan, { planHash: prepared.plan.planHash, confirmedAt: dependencies.now() });
      return confirmed.kind === "DELETED" ? Object.freeze({ kind: "FORGOTTEN" }) : Object.freeze({ kind: "FAILED", code: confirmed.kind });
    } catch (error) {
      rethrowIntegrity(error);
      return Object.freeze({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" });
    }
  }

  async function list(): Promise<readonly RememberedTerm[]> {
    const terms: RememberedTerm[] = [];
    for (const { head, revision } of await termRevisions()) {
      const medicine = await activeMedicineHead(revision.payload.meaning.medication.recordId);
      terms.push(Object.freeze({ recordId: head.recordId, revisionId: head.headRevisionId, revisionNumber: head.headRevisionNumber, language: revision.payload.language, phrase: revision.payload.phrase, medication: medicine ? refOf(medicine) : null }));
    }
    return Object.freeze(terms.sort((left, right) => left.phrase.localeCompare(right.phrase)));
  }

  async function knownMedications(): Promise<readonly VoiceMedicationRef[]> {
    return Object.freeze((await activeMedicines()).map((entry) => entry.medication));
  }

  async function directory(language: TerminologyLanguage): Promise<VoiceMedicineDirectory> {
    const terms = (await list()).filter((term): term is RememberedTerm & { medication: VoiceMedicationRef } => term.language === language && term.medication !== null);
    const names = (await activeMedicines()).flatMap((entry) => entry.names.map((name) => Object.freeze({ name, medication: entry.medication })));
    return Object.freeze({ terms: Object.freeze(terms.map((term) => Object.freeze({ phrase: term.phrase, medication: term.medication }))), names: Object.freeze(names) });
  }

  return Object.freeze({ remember, change, forget, list, activeMedicines, knownMedications, directory });
}
