import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  auditEventIdSchema,
  instantSchema,
  recordIdSchema,
  revisionActionSchema,
  revisionIdSchema,
  transactionIdSchema,
  type Instant,
} from "@/domain/shared";
import {
  createStoredRecordRevisionCodec,
  type StoredTemporalIndexFields,
} from "./stored-record-revision";
import { StorageRowValidationError } from "./storage-row-codec";

const fixtureTemporalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("EXACT_POINT"),
      instant: instantSchema,
    })
    .strict(),
  z.object({ kind: z.literal("UNKNOWN_POINT") }).strict(),
]);

const fixtureRevisionSchema = z
  .object({
    schemaVersion: z.number().int().positive().safe(),
    recordType: z.literal("GLUCOSE_READING"),
    recordId: recordIdSchema,
    revisionId: revisionIdSchema,
    revisionNumber: z.number().int().positive().safe(),
    previousRevisionId: revisionIdSchema.nullable(),
    action: revisionActionSchema,
    recordedAt: instantSchema,
    revisionCreatedAt: instantSchema,
    temporal: fixtureTemporalSchema,
    provenance: z.object({ source: z.literal("TEST_FIXTURE") }).strict(),
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    payload: z.object({ decimal: z.string() }).strict(),
  })
  .strict();

type FixtureRevision = z.output<typeof fixtureRevisionSchema>;

function deriveTemporal(
  revision: FixtureRevision,
): StoredTemporalIndexFields {
  if (revision.temporal.kind === "EXACT_POINT") {
    return {
      temporalKind: "POINT",
      occurrenceSortInstant: revision.temporal.instant,
    };
  }
  return { temporalKind: "POINT" };
}

const codec = createStoredRecordRevisionCodec({
  recordTypeSchema: z.literal("GLUCOSE_READING"),
  revisionSchema: fixtureRevisionSchema,
  deriveTemporalIndexFields: deriveTemporal,
});

const ID = {
  record: "00000000-0000-4000-8000-000000000001",
  revision: "00000000-0000-4000-8000-000000000002",
  previous: "00000000-0000-4000-8000-000000000003",
  transaction: "00000000-0000-4000-8000-000000000004",
  audit: "00000000-0000-4000-8000-000000000005",
  otherRecord: "00000000-0000-4000-8000-000000000011",
  otherRevision: "00000000-0000-4000-8000-000000000012",
  otherTransaction: "00000000-0000-4000-8000-000000000014",
  otherAudit: "00000000-0000-4000-8000-000000000015",
} as const;

function makeRevision(
  temporal: FixtureRevision["temporal"] = {
    kind: "EXACT_POINT",
    instant: instantSchema.parse("2026-09-30T09:00:00Z"),
  },
): FixtureRevision {
  return fixtureRevisionSchema.parse({
    schemaVersion: 1,
    recordType: "GLUCOSE_READING",
    recordId: ID.record,
    revisionId: ID.revision,
    revisionNumber: 2,
    previousRevisionId: ID.previous,
    action: "CORRECT",
    recordedAt: "2026-09-30T08:00:00Z",
    revisionCreatedAt: "2026-09-30T10:00:00Z",
    temporal,
    provenance: { source: "TEST_FIXTURE" },
    auditEventId: ID.audit,
    transactionId: ID.transaction,
    payload: { decimal: "5.6" },
  });
}

describe("createStoredRecordRevisionCodec", () => {
  it("constructs the exact duplicated envelope and preserves the revision", () => {
    const revision = makeRevision();
    const stored = codec.create(revision);

    expect(stored).toEqual({
      revisionId: revision.revisionId,
      recordId: revision.recordId,
      recordType: revision.recordType,
      revisionNumber: revision.revisionNumber,
      previousRevisionId: revision.previousRevisionId,
      schemaVersion: revision.schemaVersion,
      action: revision.action,
      recordedAt: revision.recordedAt,
      revisionCreatedAt: revision.revisionCreatedAt,
      transactionId: revision.transactionId,
      auditEventId: revision.auditEventId,
      temporalKind: "POINT",
      occurrenceSortInstant: revision.temporal.kind === "EXACT_POINT"
        ? revision.temporal.instant
        : undefined,
      revision,
    });
    expect(codec.validateForWrite(stored)).toEqual(stored);
    expect(codec.validateAfterRead(stored)).toEqual(stored);
  });

  it.each([
    ["revisionId", ID.otherRevision],
    ["recordId", ID.otherRecord],
    ["recordType", "KETONE_READING"],
    ["revisionNumber", 3],
    ["previousRevisionId", ID.otherRevision],
    ["schemaVersion", 2],
    ["action", "CONFIRM"],
    ["recordedAt", "2026-09-29T08:00:00Z"],
    ["revisionCreatedAt", "2026-09-30T11:00:00Z"],
    ["transactionId", ID.otherTransaction],
    ["auditEventId", ID.otherAudit],
  ] as const)("rejects a mismatched duplicated %s field", (field, value) => {
    const stored = codec.create(makeRevision());
    expect(() =>
      codec.validateAfterRead({ ...stored, [field]: value }),
    ).toThrow(StorageRowValidationError);
  });

  it("reports a mismatched write envelope as validation failure", () => {
    const stored = codec.create(makeRevision());
    try {
      codec.validateForWrite({ ...stored, revisionNumber: 99 });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "STORAGE_VALIDATION_FAILED",
        table: "recordRevisions",
        boundary: "WRITE",
      });
    }
  });

  it("rejects an unknown outer field", () => {
    const stored = codec.create(makeRevision());
    expect(() =>
      codec.validateAfterRead({ ...stored, metadata: {} }),
    ).toThrow(StorageRowValidationError);
  });

  it("rejects an unknown nested revision field", () => {
    const stored = codec.create(makeRevision());
    expect(() =>
      codec.validateAfterRead({
        ...stored,
        revision: { ...stored.revision, metadata: {} },
      }),
    ).toThrow(StorageRowValidationError);
  });

  it("rejects a changed occurrence sort instant", () => {
    const stored = codec.create(makeRevision());
    expect(() =>
      codec.validateAfterRead({
        ...stored,
        occurrenceSortInstant: "2026-09-30T09:30:00Z",
      }),
    ).toThrow(StorageRowValidationError);
  });

  it("rejects a missing required occurrence sort instant", () => {
    const stored = codec.create(makeRevision());
    const { occurrenceSortInstant: _omit, ...withoutOccurrence } = stored;
    expect(() => codec.validateAfterRead(withoutOccurrence)).toThrow(
      StorageRowValidationError,
    );
  });

  it("preserves temporal absence for an unknown point", () => {
    const stored = codec.create(makeRevision({ kind: "UNKNOWN_POINT" }));
    expect(stored.temporalKind).toBe("POINT");
    expect("occurrenceSortInstant" in stored).toBe(false);
    expect("effectiveStartSortInstant" in stored).toBe(false);
    expect("effectiveEndSortInstant" in stored).toBe(false);
    expect("localDateSortKey" in stored).toBe(false);
  });

  it("rejects an invented sentinel for an unknown point", () => {
    const stored = codec.create(makeRevision({ kind: "UNKNOWN_POINT" }));
    expect(() =>
      codec.validateAfterRead({
        ...stored,
        occurrenceSortInstant: "1970-01-01T00:00:00Z",
      }),
    ).toThrow(StorageRowValidationError);
  });

  it("rejects a temporal field that is present with undefined", () => {
    const stored = codec.create(makeRevision({ kind: "UNKNOWN_POINT" }));
    expect(() =>
      codec.validateAfterRead({
        ...stored,
        occurrenceSortInstant: undefined,
      }),
    ).toThrow(StorageRowValidationError);
  });

  it("rejects a derivation that returns an optional field as explicit undefined", () => {
    const invalidDerivativeCodec = createStoredRecordRevisionCodec({
      recordTypeSchema: z.literal("GLUCOSE_READING"),
      revisionSchema: fixtureRevisionSchema,
      deriveTemporalIndexFields: () => ({
        temporalKind: "POINT",
        occurrenceSortInstant: undefined,
      }),
    });

    expect(() => invalidDerivativeCodec.create(makeRevision())).toThrow(
      StorageRowValidationError,
    );
  });

  it("does not expose a default factory without the exact revision schema", () => {
    if (false) {
      // @ts-expect-error revisionSchema is mandatory
      createStoredRecordRevisionCodec({
        recordTypeSchema: z.literal("GLUCOSE_READING"),
        deriveTemporalIndexFields: deriveTemporal,
      });

      // @ts-expect-error temporal derivation is mandatory
      createStoredRecordRevisionCodec({
        recordTypeSchema: z.literal("GLUCOSE_READING"),
        revisionSchema: fixtureRevisionSchema,
      });
    }
    expect(true).toBe(true);
  });
});

const _instantTypeProof: Instant = instantSchema.parse(
  "2026-09-30T10:00:00Z",
);
void _instantTypeProof;
