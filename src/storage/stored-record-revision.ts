import { z, type ZodType, type ZodTypeDef } from "zod";
import {
  auditEventIdSchema,
  instantSchema,
  localDateSchema,
  recordIdSchema,
  revisionActionSchema,
  revisionIdSchema,
  transactionIdSchema,
  type AuditEventId,
  type Instant,
  type LocalDate,
  type RecordId,
  type RecordType,
  type RevisionAction,
  type RevisionId,
  type TransactionId,
} from "@/domain/shared";
import {
  createStorageRowCodec,
  StorageRowValidationError,
  type StorageRowCodec,
} from "./storage-row-codec";

export type StoredTemporalIndexFields = {
  temporalKind: "POINT" | "INTERVAL" | "ATEMPORAL";
  occurrenceSortInstant?: Instant;
  effectiveStartSortInstant?: Instant;
  effectiveEndSortInstant?: Instant;
  localDateSortKey?: LocalDate;
};

type RevisionStorageEnvelope<TType extends RecordType> = {
  schemaVersion: number;
  recordType: TType;
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  previousRevisionId: RevisionId | null;
  action: RevisionAction;
  recordedAt: Instant;
  revisionCreatedAt: Instant;
  auditEventId: AuditEventId;
  transactionId: TransactionId;
};

export type StoredRecordRevision<TRevision> = {
  revisionId: RevisionId;
  recordId: RecordId;
  recordType: RecordType;
  revisionNumber: number;
  previousRevisionId: RevisionId | null;
  schemaVersion: number;
  action: RevisionAction;
  recordedAt: Instant;
  revisionCreatedAt: Instant;
  transactionId: TransactionId;
  auditEventId: AuditEventId;
  temporalKind: "POINT" | "INTERVAL" | "ATEMPORAL";
  occurrenceSortInstant?: Instant;
  effectiveStartSortInstant?: Instant;
  effectiveEndSortInstant?: Instant;
  localDateSortKey?: LocalDate;
  revision: TRevision;
};

export type StoredRecordRevisionCodec<TRevision> = StorageRowCodec<
  StoredRecordRevision<TRevision>
> & {
  create(revision: TRevision): StoredRecordRevision<TRevision>;
};

const temporalIndexFieldsSchema = z
  .object({
    temporalKind: z.enum(["POINT", "INTERVAL", "ATEMPORAL"]),
    occurrenceSortInstant: instantSchema.optional(),
    effectiveStartSortInstant: instantSchema.optional(),
    effectiveEndSortInstant: instantSchema.optional(),
    localDateSortKey: localDateSchema.optional(),
  })
  .strict()
  .superRefine((fields, ctx) => {
    for (const key of [
      "occurrenceSortInstant",
      "effectiveStartSortInstant",
      "effectiveEndSortInstant",
      "localDateSortKey",
    ] as const) {
      if (
        Object.prototype.hasOwnProperty.call(fields, key) &&
        fields[key] === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPTIONAL_TEMPORAL_INDEX_FIELD_MUST_BE_ABSENT",
          path: [key],
        });
      }
    }
  });

const OPTIONAL_TEMPORAL_KEYS = [
  "occurrenceSortInstant",
  "effectiveStartSortInstant",
  "effectiveEndSortInstant",
  "localDateSortKey",
] as const;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function createStoredRecordRevisionCodec<
  TType extends RecordType,
  TRevision extends RevisionStorageEnvelope<TType>,
>(options: {
  recordTypeSchema: ZodType<TType, ZodTypeDef, unknown>;
  revisionSchema: ZodType<TRevision, ZodTypeDef, unknown>;
  deriveTemporalIndexFields(
    revision: TRevision,
  ): StoredTemporalIndexFields;
}): StoredRecordRevisionCodec<TRevision> {
  const storedSchema = z
    .object({
      revisionId: revisionIdSchema,
      recordId: recordIdSchema,
      recordType: options.recordTypeSchema,
      revisionNumber: z.number().int().positive().safe(),
      previousRevisionId: revisionIdSchema.nullable(),
      schemaVersion: z.number().int().positive().safe(),
      action: revisionActionSchema,
      recordedAt: instantSchema,
      revisionCreatedAt: instantSchema,
      transactionId: transactionIdSchema,
      auditEventId: auditEventIdSchema,
      temporalKind: z.enum(["POINT", "INTERVAL", "ATEMPORAL"]),
      occurrenceSortInstant: instantSchema.optional(),
      effectiveStartSortInstant: instantSchema.optional(),
      effectiveEndSortInstant: instantSchema.optional(),
      localDateSortKey: localDateSchema.optional(),
      revision: options.revisionSchema,
    })
    .strict()
    .superRefine((row, ctx) => {
      // Zod 3's generic object helper conservatively marks a generic schema
      // output optional at the type level. Runtime parsing still requires the
      // field; keep an explicit guard before restoring the exact generic type.
      if (row.revision === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "REVISION_REQUIRED",
          path: ["revision"],
        });
        return;
      }
      const revision = row.revision as TRevision;
      const duplicatedFields = [
        "revisionId",
        "recordId",
        "recordType",
        "revisionNumber",
        "previousRevisionId",
        "schemaVersion",
        "action",
        "recordedAt",
        "revisionCreatedAt",
        "transactionId",
        "auditEventId",
      ] as const;

      for (const field of duplicatedFields) {
        if (row[field] !== revision[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "REVISION_ENVELOPE_MISMATCH",
            path: [field],
          });
        }
      }

      let derived: StoredTemporalIndexFields;
      try {
        const result = temporalIndexFieldsSchema.safeParse(
          options.deriveTemporalIndexFields(revision),
        );
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "INVALID_TEMPORAL_INDEX_DERIVATION",
            path: ["temporalKind"],
          });
          return;
        }
        derived = result.data as StoredTemporalIndexFields;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "TEMPORAL_INDEX_DERIVATION_FAILED",
          path: ["temporalKind"],
        });
        return;
      }

      if (row.temporalKind !== derived.temporalKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "TEMPORAL_KIND_MISMATCH",
          path: ["temporalKind"],
        });
      }

      for (const field of OPTIONAL_TEMPORAL_KEYS) {
        const rowHasField = hasOwn(row, field);
        const derivedHasField = hasOwn(derived, field);
        if (
          rowHasField !== derivedHasField ||
          (rowHasField && row[field] !== derived[field])
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "TEMPORAL_INDEX_FIELD_MISMATCH",
            path: [field],
          });
        }
      }
    })
    .transform(
      (row): StoredRecordRevision<TRevision> =>
        row as StoredRecordRevision<TRevision>,
    );

  const rowCodec = createStorageRowCodec<StoredRecordRevision<TRevision>>(
    "recordRevisions",
    storedSchema,
  );

  return Object.freeze({
    ...rowCodec,
    create(revision: TRevision): StoredRecordRevision<TRevision> {
      let temporal: StoredTemporalIndexFields;
      try {
        temporal = temporalIndexFieldsSchema.parse(
          options.deriveTemporalIndexFields(revision),
        ) as StoredTemporalIndexFields;
      } catch {
        throw new StorageRowValidationError(
          "STORAGE_VALIDATION_FAILED",
          "recordRevisions",
          "WRITE",
        );
      }

      return rowCodec.validateForWrite({
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
        ...temporal,
        revision,
      });
    },
  });
}
