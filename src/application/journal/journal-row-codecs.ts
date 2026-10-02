import { z } from "zod";
import {
  createRecordRevisionSchema,
  type RecordRevision,
} from "@/domain/shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "@/domain/shared/provenance";
import { recordTypeSchema } from "@/domain/shared/record-catalogue";
import { instantSchema, type Instant } from "@/domain/shared/time";
import { localDateSchema, type LocalDate } from "@/domain/shared/time";
import {
  glucoseReadingPayloadSchema,
  type GlucoseReadingPayload,
} from "@/domain/health-records/glucose-reading";
import { readingTemporalSchema, type ReadingTemporal } from "@/domain/health-records/reading-temporal";
import {
  medicationEventPayloadSchema,
  type MedicationEventPayload,
} from "@/domain/health-records/medication-event";
import { medicationEventTemporalSchema, type MedicationEventTemporal } from "@/domain/health-records/medication-event";
import {
  intakeEventPayloadSchema,
  type IntakeEventPayload,
} from "@/domain/health-records/intake-event";
import { intakeTemporalSchema, type IntakeTemporal } from "@/domain/health-records/observation-temporal";
import {
  createStoredRecordRevisionCodec,
  type StoredRecordRevision,
  type StoredTemporalIndexFields,
} from "@/storage/stored-record-revision";
import { createStorageRowCodec, type StorageRowCodec } from "@/storage/storage-row-codec";

// ---------------------------------------------------------------------------
// Typed revision types for the three Packet 6 record types
// ---------------------------------------------------------------------------

export type GlucoseReadingRevision = RecordRevision<
  "GLUCOSE_READING",
  GlucoseReadingPayload,
  ReadingTemporal,
  ProvenanceCore
>;

export type MedicationEventRevision = RecordRevision<
  "MEDICATION_EVENT",
  MedicationEventPayload,
  MedicationEventTemporal,
  ProvenanceCore
>;

export type IntakeEventRevision = RecordRevision<
  "INTAKE_EVENT",
  IntakeEventPayload,
  IntakeTemporal,
  ProvenanceCore
>;

export type Packet6JournalRevision =
  | GlucoseReadingRevision
  | MedicationEventRevision
  | IntakeEventRevision;

// ---------------------------------------------------------------------------
// Strict revision schemas composed from domain contracts
// ---------------------------------------------------------------------------

const glucoseReadingRevisionSchema = createRecordRevisionSchema(
  z.literal("GLUCOSE_READING"),
  glucoseReadingPayloadSchema,
  readingTemporalSchema,
  provenanceCoreSchema,
);

const medicationEventRevisionSchema = createRecordRevisionSchema(
  z.literal("MEDICATION_EVENT"),
  medicationEventPayloadSchema,
  medicationEventTemporalSchema,
  provenanceCoreSchema,
);

const intakeEventRevisionSchema = createRecordRevisionSchema(
  z.literal("INTAKE_EVENT"),
  intakeEventPayloadSchema,
  intakeTemporalSchema,
  provenanceCoreSchema,
);

export const packet6JournalRevisionSchema = z.union([
  glucoseReadingRevisionSchema,
  medicationEventRevisionSchema,
  intakeEventRevisionSchema,
]);

// ---------------------------------------------------------------------------
// Temporal index derivation — occurrence only, derived from POINT temporal
// ---------------------------------------------------------------------------

function resolveOccurrenceInstant(
  temporal: ReadingTemporal | MedicationEventTemporal | IntakeTemporal,
): Instant | null {
  if (temporal.kind !== "POINT") return null;
  const occ = temporal.occurrence;
  switch (occ.kind) {
    case "EXACT":
      return occ.instantUtc;
    case "APPROXIMATE":
      return occ.approximateInstantUtc;
    case "DATE_ONLY":
    case "UNKNOWN":
      return null;
  }
}

function resolveLocalDate(
  temporal: ReadingTemporal | MedicationEventTemporal | IntakeTemporal,
): LocalDate | null {
  if (temporal.kind !== "POINT") return null;
  const occ = temporal.occurrence;
  if (occ.kind === "DATE_ONLY") return occ.localDate;
  return null;
}

function deriveTemporalIndexFields(
  revision: Packet6JournalRevision,
): StoredTemporalIndexFields {
  const occurrenceSortInstant = resolveOccurrenceInstant(revision.temporal);
  const localDateSortKey = resolveLocalDate(revision.temporal);

  if (occurrenceSortInstant !== null) {
    return {
      temporalKind: "POINT" as const,
      occurrenceSortInstant,
    };
  }
  if (localDateSortKey !== null) {
    return {
      temporalKind: "POINT" as const,
      localDateSortKey,
    };
  }
  return {
    temporalKind: "POINT" as const,
  };
}

// ---------------------------------------------------------------------------
// Stored revision codecs for each record type
// ---------------------------------------------------------------------------

export const glucoseReadingRevisionCodec = createStoredRecordRevisionCodec<
  "GLUCOSE_READING",
  GlucoseReadingRevision
>({
  recordTypeSchema: z.literal("GLUCOSE_READING"),
  revisionSchema: glucoseReadingRevisionSchema as z.ZodType<
    GlucoseReadingRevision,
    z.ZodTypeDef,
    unknown
  >,
  deriveTemporalIndexFields,
});

export const medicationEventRevisionCodec = createStoredRecordRevisionCodec<
  "MEDICATION_EVENT",
  MedicationEventRevision
>({
  recordTypeSchema: z.literal("MEDICATION_EVENT"),
  revisionSchema: medicationEventRevisionSchema as z.ZodType<
    MedicationEventRevision,
    z.ZodTypeDef,
    unknown
  >,
  deriveTemporalIndexFields,
});

export const intakeEventRevisionCodec = createStoredRecordRevisionCodec<
  "INTAKE_EVENT",
  IntakeEventRevision
>({
  recordTypeSchema: z.literal("INTAKE_EVENT"),
  revisionSchema: intakeEventRevisionSchema as z.ZodType<
    IntakeEventRevision,
    z.ZodTypeDef,
    unknown
  >,
  deriveTemporalIndexFields,
});

// ---------------------------------------------------------------------------
// Rejecting codecs for unused reverse-dependency and engine-evaluation rows
// ---------------------------------------------------------------------------

/**
 * Internal rejecting codec for the reverse-dependency table.
 * Packet 6 never writes reverse dependencies, so any non-empty row
 * must fail validation.
 */
export const rejectingReverseDependencyCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(value: unknown): never {
    throw new Error("REVERSE_DEPENDENCIES_NOT_USED_IN_PACKET_6");
  },
  validateAfterRead(value: unknown): never {
    throw new Error("REVERSE_DEPENDENCIES_NOT_USED_IN_PACKET_6");
  },
}) as StorageRowCodec<never>;

/**
 * Internal rejecting codec for the engine-evaluation-audit table.
 * Packet 6 never writes engine evaluations, so any non-empty row
 * must fail validation.
 */
export const rejectingEvaluationAuditCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(value: unknown): never {
    throw new Error("ENGINE_EVALUATION_AUDITS_NOT_USED_IN_PACKET_6");
  },
  validateAfterRead(value: unknown): never {
    throw new Error("ENGINE_EVALUATION_AUDITS_NOT_USED_IN_PACKET_6");
  },
}) as StorageRowCodec<never>;

// ---------------------------------------------------------------------------
// Union codec: validates any Packet 6 revision row after read
// ---------------------------------------------------------------------------

export type Packet6StoredRevision =
  | StoredRecordRevision<GlucoseReadingRevision>
  | StoredRecordRevision<MedicationEventRevision>
  | StoredRecordRevision<IntakeEventRevision>;

export function validatePacket6StoredRevision(
  row: unknown,
): Packet6StoredRevision {
  // Try each codec in turn. Each rejects if the recordType doesn't match.
  const attempts: Packet6StoredRevision[] = [];
  for (const codec of [
    glucoseReadingRevisionCodec,
    medicationEventRevisionCodec,
    intakeEventRevisionCodec,
  ]) {
    try {
      attempts.push(codec.validateAfterRead(row));
    } catch {
      // Continue to next codec
    }
  }
  if (attempts.length === 0) {
    throw new Error("PACKET6_REVISION_VALIDATION_FAILED");
  }
  if (attempts.length > 1) {
    // Should never happen because recordType is discriminated
    throw new Error("PACKET6_REVISION_AMBIGUOUS");
  }
  return attempts[0]!;
}

// Re-export the codec factory type for the command service
export type { StoredRecordRevision };
