import { z } from "zod";
import { learnedKnowledgeRevisionSchema, type LearnedKnowledgeRevision } from "@/domain/learning";
import {
  patternEvidenceSnapshotRevisionSchema,
  patternObservationRevisionSchema,
  type PatternEvidenceSnapshotRevision,
  type PatternObservationRevision,
} from "@/domain/patterns";
import { createStoredRecordRevisionCodec, type StoredRecordRevision } from "@/storage/stored-record-revision";
import { StorageRowValidationError, type StorageRowCodec } from "@/storage/storage-row-codec";

/**
 * Exact stored-revision codecs for the three Packet 7A derived record types.
 * All three are ATEMPORAL, so no occurrence or effective-period index fields
 * are derived. They share the generic `recordRevisions` table.
 */

const atemporalIndex = () => ({ temporalKind: "ATEMPORAL" as const });

export const learnedKnowledgeRevisionCodec = createStoredRecordRevisionCodec<"LEARNED_KNOWLEDGE", LearnedKnowledgeRevision>({
  recordTypeSchema: z.literal("LEARNED_KNOWLEDGE"),
  revisionSchema: learnedKnowledgeRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

export const patternObservationRevisionCodec = createStoredRecordRevisionCodec<"PATTERN_OBSERVATION", PatternObservationRevision>({
  recordTypeSchema: z.literal("PATTERN_OBSERVATION"),
  revisionSchema: patternObservationRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

export const patternEvidenceSnapshotRevisionCodec = createStoredRecordRevisionCodec<
  "PATTERN_EVIDENCE_SNAPSHOT",
  PatternEvidenceSnapshotRevision
>({
  recordTypeSchema: z.literal("PATTERN_EVIDENCE_SNAPSHOT"),
  revisionSchema: patternEvidenceSnapshotRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

export type DerivedRecordRevision = LearnedKnowledgeRevision | PatternObservationRevision | PatternEvidenceSnapshotRevision;
export type StoredDerivedRevision = StoredRecordRevision<DerivedRecordRevision>;

export const DERIVED_RECORD_TYPES = Object.freeze([
  "LEARNED_KNOWLEDGE",
  "PATTERN_OBSERVATION",
  "PATTERN_EVIDENCE_SNAPSHOT",
] as const);

export type DerivedRecordType = (typeof DERIVED_RECORD_TYPES)[number];

function codecFor(recordType: unknown): StorageRowCodec<StoredDerivedRevision> | null {
  if (recordType === "LEARNED_KNOWLEDGE") return learnedKnowledgeRevisionCodec as StorageRowCodec<StoredDerivedRevision>;
  if (recordType === "PATTERN_OBSERVATION") return patternObservationRevisionCodec as StorageRowCodec<StoredDerivedRevision>;
  if (recordType === "PATTERN_EVIDENCE_SNAPSHOT") {
    return patternEvidenceSnapshotRevisionCodec as StorageRowCodec<StoredDerivedRevision>;
  }
  return null;
}

/** Dispatching codec: accepts only the three derived types, each exactly. */
export const derivedRevisionRowCodec: StorageRowCodec<StoredDerivedRevision> = Object.freeze({
  validateForWrite(value: unknown): StoredDerivedRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "recordRevisions", "WRITE");
    return codec.validateForWrite(value);
  },
  validateAfterRead(value: unknown): StoredDerivedRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ");
    return codec.validateAfterRead(value);
  },
});
