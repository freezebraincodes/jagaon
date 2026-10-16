import { z } from "zod";
import { commandIdSchema, type CommandId, type CorrelationId, type DomainEventId } from "@/application/contracts/command-event-identifiers";
import { fingerprint } from "@/application/intelligence/metrics";
import { OwnerPlanError } from "@/application/owner-plan-support";
import type { AuditEventId, Instant, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import {
  PERSONAL_NOTE_RECORD_TYPE,
  PERSONAL_NOTE_SCHEMA_VERSION,
  personalNotePayloadSchema,
  personalNoteRevisionSchema,
  type PersonalNotePayload,
  type PersonalNoteRevision,
} from "@/domain/notes/personal-note";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import type { JagaOnDatabase } from "@/storage/database";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { buildPersonalNoteCommitPlan, createPersonalNoteCommandStore } from "./personal-note-persistence";

/**
 * Owner decision 2026-10-14 (My notes): the personal-note command service. `createPersonalNote` is the one explicit "save this note"
 * command: it validates the payload, records one PERSONAL_NOTE CREATE with a patient-entry provenance (AI_ASSISTED only when the note
 * says an AI service helped), an audit row and a domain event (closed reason only), in one authoritative transaction. A caller-supplied
 * `commandId` makes a retry idempotent: the same id with the same payload returns the first result; with another payload it fails.
 * Deleting a note is the existing patient permanent deletion (`runtime.recordDeletion`), not this service.
 */
export type PersonalNoteDependencies = Readonly<{
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
}>;

export type CreatePersonalNoteInput = Readonly<{ payload: PersonalNotePayload; commandId?: string }>;

export type PersonalNoteCommitResult =
  | Readonly<{ kind: "COMMITTED"; recordId: RecordId; revisionId: RevisionId }>
  | Readonly<{ kind: "FAILED"; code: "VALIDATION_FAILED" | "STORAGE_UNAVAILABLE" | "COMMIT_FAILED" }>;

export type PersonalNoteCommandService = Readonly<{
  createPersonalNote(input: CreatePersonalNoteInput): Promise<PersonalNoteCommitResult>;
}>;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Trims the free texts and drops repeated cues and themes; everything else is validated exactly as given. */
function normalisePayload(payload: PersonalNotePayload): PersonalNotePayload {
  const raw = (payload ?? {}) as Partial<PersonalNotePayload>;
  return personalNotePayloadSchema.parse({
    ...raw,
    text: typeof raw.text === "string" ? raw.text.trim() : raw.text,
    feelingCues: Array.isArray(raw.feelingCues) ? unique(raw.feelingCues) : raw.feelingCues,
    themes: Array.isArray(raw.themes) ? unique(raw.themes) : raw.themes,
    turns: Array.isArray(raw.turns) ? raw.turns.map((turn) => (turn && typeof turn.text === "string" ? { ...turn, text: turn.text.trim() } : turn)) : raw.turns,
  });
}

/** An integrity failure is never turned into an ordinary FAILED result; it is rethrown so the app's integrity gate sees it. */
function rethrowIntegrity(error: unknown): void {
  if (error instanceof StorageRowValidationError && error.code === "STORAGE_INTEGRITY_FAILED") throw error;
  if (error instanceof CommandTransactionError && error.code === "STORAGE_INTEGRITY_FAILED") throw error;
}

const failed = (code: "VALIDATION_FAILED" | "STORAGE_UNAVAILABLE" | "COMMIT_FAILED"): PersonalNoteCommitResult => Object.freeze({ kind: "FAILED", code });

export function createPersonalNoteService(database: JagaOnDatabase, dependencies: PersonalNoteDependencies): PersonalNoteCommandService {
  const store = createPersonalNoteCommandStore(database);
  const { ids } = dependencies;

  async function createPersonalNote(input: CreatePersonalNoteInput): Promise<PersonalNoteCommitResult> {
    let payload: PersonalNotePayload;
    let commandId: CommandId;
    try {
      payload = normalisePayload(input?.payload);
      commandId = input?.commandId === undefined ? ids.commandId() : commandIdSchema.parse(input.commandId);
    } catch {
      return failed("VALIDATION_FAILED");
    }
    try {
      const now = dependencies.now();
      const revision = personalNoteRevisionSchema.parse({
        schemaVersion: PERSONAL_NOTE_SCHEMA_VERSION,
        recordType: PERSONAL_NOTE_RECORD_TYPE,
        recordId: ids.recordId(),
        revisionId: ids.revisionId(),
        revisionNumber: 1,
        previousRevisionId: null,
        action: "CREATE",
        recordedAt: now,
        revisionCreatedAt: now,
        temporal: { kind: "ATEMPORAL" },
        provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: payload.aiUsed ? "AI_ASSISTED" : "NONE" },
        auditEventId: ids.auditEventId(),
        transactionId: ids.transactionId(),
        payload,
      }) as PersonalNoteRevision;
      const plan = buildPersonalNoteCommitPlan({
        commandId,
        // The hash binds the command to its content, so a retried id with another note is refused.
        commandHash: fingerprint({ commandName: "RECORD_PERSONAL_NOTE", payload }),
        correlationId: ids.correlationId(),
        transactionId: revision.transactionId,
        completedAt: now,
        revision,
        eventId: ids.domainEventId(),
      });
      const receipt = await store.execute(plan);
      if (receipt.outcome !== "COMMITTED") return failed("COMMIT_FAILED");
      // A replayed command returns the first commit's record.
      const saved = receipt.resultingRevisions.find((ref) => ref.recordType === PERSONAL_NOTE_RECORD_TYPE);
      if (!saved) return failed("COMMIT_FAILED");
      return Object.freeze({ kind: "COMMITTED", recordId: saved.recordId, revisionId: saved.revisionId });
    } catch (error) {
      rethrowIntegrity(error);
      if (error instanceof OwnerPlanError || error instanceof z.ZodError || error instanceof StorageRowValidationError) return failed("VALIDATION_FAILED");
      if (error instanceof CommandTransactionError && error.code === "COMMAND_REPLAY_MISMATCH") return failed("COMMIT_FAILED");
      return failed("STORAGE_UNAVAILABLE");
    }
  }

  return Object.freeze({ createPersonalNote });
}
