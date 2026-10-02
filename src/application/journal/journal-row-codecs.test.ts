import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  packet6JournalRevisionSchema,
  glucoseReadingRevisionCodec,
  medicationEventRevisionCodec,
  intakeEventRevisionCodec,
  rejectingReverseDependencyCodec,
  rejectingEvaluationAuditCodec,
  type GlucoseReadingRevision,
  type MedicationEventRevision,
  type IntakeEventRevision,
} from "./journal-row-codecs";
import { provenanceCoreSchema, type ProvenanceCore } from "@/domain/shared/provenance";
import { glucoseReadingPayloadSchema } from "@/domain/health-records/glucose-reading";
import { readingTemporalSchema } from "@/domain/health-records/reading-temporal";
import { medicationEventPayloadSchema } from "@/domain/health-records/medication-event";
import { medicationEventTemporalSchema } from "@/domain/health-records/medication-event";
import { intakeEventPayloadSchema } from "@/domain/health-records/intake-event";
import { intakeTemporalSchema } from "@/domain/health-records/observation-temporal";
import { createRecordRevisionSchema } from "@/domain/shared/revision";
import type { RecordId, RevisionId, AuditEventId, TransactionId } from "@/domain/shared/identifiers";
import type { Instant } from "@/domain/shared/time";

const VALID_RECORD_ID = "00000000-0000-4000-8000-000000000001" as RecordId;
const VALID_REVISION_ID = "00000000-0000-4000-8000-000000000002" as RevisionId;
const VALID_AUDIT_ID = "00000000-0000-4000-8000-000000000003" as AuditEventId;
const VALID_TX_ID = "00000000-0000-4000-8000-000000000004" as TransactionId;
const VALID_INSTANT = "2026-10-02T08:00:00Z" as Instant;

const VALID_PROVENANCE: ProvenanceCore = {
  sourceKind: "PATIENT_ENTRY",
  captureMethod: "FORM",
  initiator: "PATIENT",
  assistance: "NONE",
};

function baseGlucoseRevision(): GlucoseReadingRevision {
  return {
    schemaVersion: 1,
    recordType: "GLUCOSE_READING",
    recordId: VALID_RECORD_ID,
    revisionId: VALID_REVISION_ID,
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: VALID_INSTANT,
    revisionCreatedAt: VALID_INSTANT,
    temporal: {
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: VALID_INSTANT,
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    },
    provenance: VALID_PROVENANCE,
    auditEventId: VALID_AUDIT_ID,
    transactionId: VALID_TX_ID,
    payload: {
      measurement: {
        enteredValue: "7.2" as any,
        enteredUnit: "MMOL_L",
        normalization: null,
      },
      measurementMethod: "FINGERSTICK_METER",
      context: { kind: "UNSPECIFIED" },
    },
  } as unknown as GlucoseReadingRevision;
}

function baseMedicationRevision(): MedicationEventRevision {
  return {
    schemaVersion: 1,
    recordType: "MEDICATION_EVENT",
    recordId: VALID_RECORD_ID,
    revisionId: VALID_REVISION_ID,
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: VALID_INSTANT,
    revisionCreatedAt: VALID_INSTANT,
    temporal: {
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: VALID_INSTANT,
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    },
    provenance: VALID_PROVENANCE,
    auditEventId: VALID_AUDIT_ID,
    transactionId: VALID_TX_ID,
    payload: {
      state: "TAKEN",
      medication: {
        recordType: "MEDICATION",
        recordId: VALID_RECORD_ID,
        revisionId: VALID_REVISION_ID,
      },
      amountTaken: {
        kind: "KNOWN",
        amount: {
          value: "10" as any,
          unit: "UNIT",
        },
      },
    },
  } as unknown as MedicationEventRevision;
}

function baseIntakeRevision(): IntakeEventRevision {
  return {
    schemaVersion: 1,
    recordType: "INTAKE_EVENT",
    recordId: VALID_RECORD_ID,
    revisionId: VALID_REVISION_ID,
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: VALID_INSTANT,
    revisionCreatedAt: VALID_INSTANT,
    temporal: {
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: VALID_INSTANT,
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    },
    provenance: VALID_PROVENANCE,
    auditEventId: VALID_AUDIT_ID,
    transactionId: VALID_TX_ID,
    payload: {
      intakeKind: "MEAL",
      intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" },
      occasion: "ROUTINE",
      foodIncluded: "YES",
      drinkIncluded: "NO",
      items: [{ kind: "FOOD", label: "Rice" }],
    },
  } as unknown as IntakeEventRevision;
}

describe("journal-row-codecs", () => {
  // --- Schema-level tests ---

  it("accepts a valid glucose reading revision", () => {
    const result = packet6JournalRevisionSchema.safeParse(baseGlucoseRevision());
    expect(result.success).toBe(true);
  });

  it("accepts a valid medication event revision", () => {
    const result = packet6JournalRevisionSchema.safeParse(baseMedicationRevision());
    expect(result.success).toBe(true);
  });

  it("accepts a valid intake event revision", () => {
    const result = packet6JournalRevisionSchema.safeParse(baseIntakeRevision());
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field on a glucose revision", () => {
    const bad = { ...baseGlucoseRevision(), extraField: "no" } as any;
    const result = packet6JournalRevisionSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an envelope mismatch (recordType vs revision.recordType)", () => {
    const bad = {
      ...baseGlucoseRevision(),
      recordType: "INTAKE_EVENT" as any,
    };
    const result = packet6JournalRevisionSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects all other record types (e.g. KETONE_READING)", () => {
    const bad = {
      ...baseGlucoseRevision(),
      recordType: "KETONE_READING" as any,
    } as any;
    const result = packet6JournalRevisionSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  // --- Codec-level tests ---

  it("glucose codec creates and validates a stored revision round-trip", () => {
    const revision = baseGlucoseRevision();
    const stored = glucoseReadingRevisionCodec.create(revision);
    const revalidated = glucoseReadingRevisionCodec.validateAfterRead(stored);
    expect(revalidated.recordType).toBe("GLUCOSE_READING");
    expect(revalidated.recordId).toBe(VALID_RECORD_ID);
  });

  it("medication codec creates and validates a stored revision round-trip", () => {
    const revision = baseMedicationRevision();
    const stored = medicationEventRevisionCodec.create(revision);
    const revalidated = medicationEventRevisionCodec.validateAfterRead(stored);
    expect(revalidated.recordType).toBe("MEDICATION_EVENT");
  });

  it("intake codec creates and validates a stored revision round-trip", () => {
    const revision = baseIntakeRevision();
    const stored = intakeEventRevisionCodec.create(revision);
    const revalidated = intakeEventRevisionCodec.validateAfterRead(stored);
    expect(revalidated.recordType).toBe("INTAKE_EVENT");
  });

  it("glucose codec rejects a stored row with a mismatched temporalKind", () => {
    const revision = baseGlucoseRevision();
    const stored = glucoseReadingRevisionCodec.create(revision);
    // Corrupt the temporalKind
    const bad = { ...stored, temporalKind: "INTERVAL" as any };
    expect(() => glucoseReadingRevisionCodec.validateAfterRead(bad)).toThrow();
  });

  it("rejecting reverse-dependency codec never accepts a non-empty row", () => {
    expect(() => rejectingReverseDependencyCodec.validateForWrite({ a: 1 })).toThrow();
    expect(() => rejectingReverseDependencyCodec.validateAfterRead({ a: 1 })).toThrow();
  });

  it("rejecting engine-evaluation codec never accepts a non-empty row", () => {
    expect(() => rejectingEvaluationAuditCodec.validateForWrite({ a: 1 })).toThrow();
    expect(() => rejectingEvaluationAuditCodec.validateAfterRead({ a: 1 })).toThrow();
  });
});
