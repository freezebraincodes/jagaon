import { z, type ZodType, type ZodTypeDef } from "zod";
import { instantSchema, type Instant } from "@/domain/shared/time";
import type { JagaOnDatabase } from "./database";
import { eventSequenceHighWaterMarkRowSchema, type EventSequenceHighWaterMarkRow } from "./event-sequence-metadata";
import { STORAGE_FAILURE_CODES, type StorageFailureCode } from "./storage-failure";
import { createStorageRowCodec, type StorageRowCodec } from "./storage-row-codec";

/**
 * Closed storage-metadata rows (storage-backup-spec Sections 2.9, 5.1, 5.3
 * and 8.2). Only closed technical identifiers, versions, instants and
 * outcome codes are stored; strict schemas reject any other field, so a
 * passphrase, key, filename, payload or raw error can never be written here.
 *
 * The integrity lock is deliberately not a metadata row: the closed
 * `StorageMetadataKey` list has no such key (Packet 10 freeze, Section 7).
 */

/** Current logical storage schema version (Packet 10 freeze, Section 5). */
export const LOGICAL_STORAGE_SCHEMA_VERSION = 1 as const;

/**
 * Keys used by the `HACKATHON_DEMO` profile. `LOCAL_STATE_CLEANUP_PENDING` is
 * the owner-approved Corrective Pass C amendment: an optional operational
 * marker in the existing table (no new table, index, Dexie or logical
 * version), absent in normal operation and excluded from backup with the rest
 * of `storageMetadata`.
 */
export const PROFILE_METADATA_KEYS = Object.freeze([
  "DATABASE_IDENTITY",
  "EVENT_SEQUENCE_HIGH_WATER_MARK",
  "MIGRATION_STATE",
  "RESTORE_STATE",
  "LOCAL_STATE_CLEANUP_PENDING",
] as const);
export type ProfileMetadataKey = (typeof PROFILE_METADATA_KEYS)[number];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const datasetIdentitySchema = z.string().regex(UUID_V4, "DATASET_IDENTITY_FORMAT");
export const migrationIdSchema = z.string().regex(/^jagaon\.storage\.\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/, "MIGRATION_ID_FORMAT");
export const implementationVersionSchema = z.string().regex(/^\d{1,3}[a-z]?\.\d{1,3}$/, "IMPLEMENTATION_VERSION_FORMAT");
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "SHA256_FORMAT");
/** 128-bit container identity, strict base64url without padding. */
export const containerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/, "CONTAINER_ID_FORMAT");
const versionSchema = z.number().int().positive().safe();
const failureCodeSchema = z.enum(STORAGE_FAILURE_CODES);

/** Optional fields must be absent, never present with `undefined`. */
function withoutUndefinedKeys<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((row: Record<string, unknown>, ctx) => {
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OPTIONAL_FIELD_MUST_BE_ABSENT", path: [key] });
    }
  });
}

// --- DATABASE_IDENTITY --------------------------------------------------------------------------

export type DatabaseIdentityRow = {
  key: "DATABASE_IDENTITY";
  datasetIdentity: string;
  logicalStorageSchemaVersion: number;
  createdAt: Instant;
  lastCompletedMigrationId?: string;
  updatedAt: Instant;
};

export const databaseIdentityRowSchema: ZodType<DatabaseIdentityRow, ZodTypeDef, unknown> = withoutUndefinedKeys(
  z.strictObject({
    key: z.literal("DATABASE_IDENTITY"),
    datasetIdentity: datasetIdentitySchema,
    logicalStorageSchemaVersion: versionSchema,
    createdAt: instantSchema,
    lastCompletedMigrationId: migrationIdSchema.optional(),
    updatedAt: instantSchema,
  }),
).transform((row) => row as DatabaseIdentityRow);

// --- MIGRATION_STATE ----------------------------------------------------------------------------

export const MIGRATION_PHASES = Object.freeze([
  "IDLE",
  "PREPARING",
  "RUNNING",
  "VERIFYING",
  "COMPLETED",
  "FAILED_RECOVERABLE",
  "FAILED_BLOCKING",
] as const);
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

export const MIGRATION_STEPS = Object.freeze(["PREFLIGHT", "TRANSFORM", "VERIFY"] as const);
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

export type MigrationStateRow = {
  key: "MIGRATION_STATE";
  phase: MigrationPhase;
  migrationId?: string;
  fromDexieVersion?: number;
  toDexieVersion?: number;
  fromLogicalSchemaVersion?: number;
  toLogicalSchemaVersion?: number;
  implementationVersion?: string;
  startedAt?: Instant;
  completedAt?: Instant;
  lastCompletedStep?: MigrationStep;
  failureCode?: StorageFailureCode;
};

export const migrationStateRowSchema: ZodType<MigrationStateRow, ZodTypeDef, unknown> = withoutUndefinedKeys(
  z.strictObject({
    key: z.literal("MIGRATION_STATE"),
    phase: z.enum(MIGRATION_PHASES),
    migrationId: migrationIdSchema.optional(),
    fromDexieVersion: versionSchema.optional(),
    toDexieVersion: versionSchema.optional(),
    // Logical 0 is only the legacy-identity migration's source label.
    fromLogicalSchemaVersion: z.number().int().nonnegative().safe().optional(),
    toLogicalSchemaVersion: versionSchema.optional(),
    implementationVersion: implementationVersionSchema.optional(),
    startedAt: instantSchema.optional(),
    completedAt: instantSchema.optional(),
    lastCompletedStep: z.enum(MIGRATION_STEPS).optional(),
    failureCode: failureCodeSchema.optional(),
  }),
)
  .refine((row) => row.phase !== "COMPLETED" || (row.migrationId !== undefined && row.completedAt !== undefined && row.failureCode === undefined), "COMPLETED_REQUIRES_EVIDENCE")
  .refine((row) => !row.phase.startsWith("FAILED") || row.failureCode !== undefined, "FAILED_REQUIRES_CODE")
  .transform((row) => row as MigrationStateRow);

// --- RESTORE_STATE ------------------------------------------------------------------------------

export const RESTORE_PHASES = Object.freeze([
  "IDLE",
  "HEADER_VALIDATED",
  "DECRYPTING",
  "PAYLOAD_VALIDATING",
  "PLAN_READY",
  "AWAITING_CONFIRMATION",
  "COMMITTING",
  "RECONCILING",
  "COMPLETED",
  "FAILED_RECOVERABLE",
  "FAILED_BLOCKING",
] as const);
export type RestorePhase = (typeof RESTORE_PHASES)[number];

export const RESTORE_MODES = Object.freeze(["RESTORE_INTO_EMPTY_DATABASE", "REPLACE_SAME_LINEAGE_DATABASE"] as const);
export type RestoreMode = (typeof RESTORE_MODES)[number];

/** Durable restore checkpoints, in the frozen reconciliation order (freeze Section 10). */
export const RESTORE_CHECKPOINTS = Object.freeze([
  "COMMITTED",
  "VERIFY_STORAGE",
  "VERIFY_REVERSE_DEPENDENCIES",
  "REBUILD_BOOTSTRAP_LOCALE",
  "RUNTIME_POINTERS",
  "RECOVER_WORK_LEASES",
  "SAFETY",
  "INQUIRY_MAINTENANCE",
  "PATTERN_LEARNING_REFRESH",
  "REMINDER_RECONCILIATION",
  "CARE_SUMMARY_INVALIDATION",
] as const);
export type RestoreCheckpoint = (typeof RESTORE_CHECKPOINTS)[number];

export type RestoreStateRow = {
  key: "RESTORE_STATE";
  phase: RestorePhase;
  operationId?: string;
  containerId?: string;
  restoreMode?: RestoreMode;
  planHash?: string;
  sourceBackupSchemaVersion?: number;
  targetLogicalStorageSchemaVersion?: number;
  startedAt?: Instant;
  committedAt?: Instant;
  completedAt?: Instant;
  lastCompletedStep?: RestoreCheckpoint;
  failureCode?: StorageFailureCode;
};

export const restoreStateRowSchema: ZodType<RestoreStateRow, ZodTypeDef, unknown> = withoutUndefinedKeys(
  z.strictObject({
    key: z.literal("RESTORE_STATE"),
    phase: z.enum(RESTORE_PHASES),
    operationId: z.string().regex(UUID_V4, "OPERATION_ID_FORMAT").optional(),
    containerId: containerIdSchema.optional(),
    restoreMode: z.enum(RESTORE_MODES).optional(),
    planHash: sha256HexSchema.optional(),
    sourceBackupSchemaVersion: versionSchema.optional(),
    targetLogicalStorageSchemaVersion: versionSchema.optional(),
    startedAt: instantSchema.optional(),
    committedAt: instantSchema.optional(),
    completedAt: instantSchema.optional(),
    lastCompletedStep: z.enum(RESTORE_CHECKPOINTS).optional(),
    failureCode: failureCodeSchema.optional(),
  }),
)
  .refine(
    (row) =>
      !["COMMITTING", "RECONCILING", "COMPLETED"].includes(row.phase) ||
      (row.operationId !== undefined && row.restoreMode !== undefined && row.planHash !== undefined),
    "DURABLE_RESTORE_REQUIRES_IDENTITY",
  )
  .refine((row) => !["RECONCILING", "COMPLETED"].includes(row.phase) || row.committedAt !== undefined, "RECONCILING_REQUIRES_COMMIT")
  .refine((row) => row.phase !== "COMPLETED" || row.completedAt !== undefined, "COMPLETED_REQUIRES_TIME")
  .refine((row) => !row.phase.startsWith("FAILED") || row.failureCode !== undefined, "FAILED_REQUIRES_CODE")
  .transform((row) => row as RestoreStateRow);

// --- LOCAL_STATE_CLEANUP_PENDING -----------------------------------------------------------------

/**
 * A previously issued delete-all removed the dataset, but at least one
 * local-state owner (browser local storage) could not confirm its keys were
 * removed. While present, persisted setup state is never trusted and every
 * owner is retried; it is removed only after all owners confirm. It carries no
 * error, browser, setup or patient data.
 */
export type LocalStateCleanupPendingRow = { key: "LOCAL_STATE_CLEANUP_PENDING"; requestedAt: Instant };

export const localStateCleanupPendingRowSchema: ZodType<LocalStateCleanupPendingRow, ZodTypeDef, unknown> = z
  .strictObject({ key: z.literal("LOCAL_STATE_CLEANUP_PENDING"), requestedAt: instantSchema })
  .transform((row) => row as LocalStateCleanupPendingRow);

// --- Closed metadata union -------------------------------------------------------------------------

export type ProfileMetadataRow = DatabaseIdentityRow | EventSequenceHighWaterMarkRow | MigrationStateRow | RestoreStateRow | LocalStateCleanupPendingRow;

const SCHEMA_BY_KEY: Readonly<Record<ProfileMetadataKey, ZodType<ProfileMetadataRow, ZodTypeDef, unknown>>> = Object.freeze({
  DATABASE_IDENTITY: databaseIdentityRowSchema,
  EVENT_SEQUENCE_HIGH_WATER_MARK: eventSequenceHighWaterMarkRowSchema,
  MIGRATION_STATE: migrationStateRowSchema,
  RESTORE_STATE: restoreStateRowSchema,
  LOCAL_STATE_CLEANUP_PENDING: localStateCleanupPendingRowSchema,
});

export const profileMetadataRowSchema: ZodType<ProfileMetadataRow, ZodTypeDef, unknown> = z
  .unknown()
  .superRefine((value, ctx) => {
    const key = (value as { key?: unknown } | null)?.key;
    const schema = typeof key === "string" ? SCHEMA_BY_KEY[key as ProfileMetadataKey] : undefined;
    if (!schema || !Object.prototype.hasOwnProperty.call(SCHEMA_BY_KEY, key as string)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNKNOWN_METADATA_KEY" });
      return;
    }
    if (!schema.safeParse(value).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_METADATA_ROW" });
  })
  .transform((value) => SCHEMA_BY_KEY[(value as { key: ProfileMetadataKey }).key].parse(value));

export const storageMetadataRowCodec: StorageRowCodec<ProfileMetadataRow> = createStorageRowCodec("storageMetadata", profileMetadataRowSchema);

const identityCodec = createStorageRowCodec("storageMetadata", databaseIdentityRowSchema);
const migrationCodec = createStorageRowCodec("storageMetadata", migrationStateRowSchema);
const restoreCodec = createStorageRowCodec("storageMetadata", restoreStateRowSchema);
const cleanupCodec = createStorageRowCodec("storageMetadata", localStateCleanupPendingRowSchema);

export function localStateCleanupPendingRow(requestedAt: Instant): LocalStateCleanupPendingRow {
  return cleanupCodec.validateForWrite({ key: "LOCAL_STATE_CLEANUP_PENDING", requestedAt });
}

/**
 * Corrective Pass D: the current local marker among stored metadata rows, if
 * any, through the strict closed codec. A malformed marker throws, so a caller
 * that must preserve it fails closed instead of discarding it.
 */
export function currentLocalStateCleanupPending(rows: readonly unknown[]): LocalStateCleanupPendingRow | null {
  const row = rows.find((candidate) => (candidate as { key?: unknown } | null)?.key === "LOCAL_STATE_CLEANUP_PENDING");
  return row === undefined ? null : cleanupCodec.validateAfterRead(row);
}

export function databaseIdentityRow(input: { datasetIdentity: string; createdAt: Instant; lastCompletedMigrationId?: string; updatedAt?: Instant }): DatabaseIdentityRow {
  return identityCodec.validateForWrite({
    key: "DATABASE_IDENTITY",
    datasetIdentity: input.datasetIdentity,
    logicalStorageSchemaVersion: LOGICAL_STORAGE_SCHEMA_VERSION,
    createdAt: input.createdAt,
    ...(input.lastCompletedMigrationId ? { lastCompletedMigrationId: input.lastCompletedMigrationId } : {}),
    updatedAt: input.updatedAt ?? input.createdAt,
  });
}

// --- Repository ---------------------------------------------------------------------------------

export type StorageMetadataRepository = {
  readIdentity(): Promise<DatabaseIdentityRow | null>;
  readMigrationState(): Promise<MigrationStateRow | null>;
  readRestoreState(): Promise<RestoreStateRow | null>;
  writeRestoreState(row: RestoreStateRow): Promise<RestoreStateRow>;
  readLocalStateCleanupPending(): Promise<LocalStateCleanupPendingRow | null>;
  writeLocalStateCleanupPending(row: LocalStateCleanupPendingRow): Promise<LocalStateCleanupPendingRow>;
  /** Removes the marker; a malformed stored marker fails closed and stays. */
  clearLocalStateCleanupPending(): Promise<void>;
};

/**
 * Validated metadata access. Reads fail closed with
 * `StorageRowValidationError(STORAGE_INTEGRITY_FAILED)`; writes accept only
 * the exact closed row.
 */
export function createStorageMetadataRepository(database: JagaOnDatabase): StorageMetadataRepository {
  const table = () => database.table("storageMetadata");
  async function read<T>(key: ProfileMetadataKey, codec: StorageRowCodec<T>): Promise<T | null> {
    const row: unknown = await table().get(key);
    return row === undefined ? null : codec.validateAfterRead(row);
  }
  return Object.freeze({
    readIdentity: () => read("DATABASE_IDENTITY", identityCodec),
    readMigrationState: () => read("MIGRATION_STATE", migrationCodec),
    readRestoreState: () => read("RESTORE_STATE", restoreCodec),
    async writeRestoreState(row: RestoreStateRow) {
      const valid = restoreCodec.validateForWrite(row);
      await table().put(valid as never);
      return valid;
    },
    readLocalStateCleanupPending: () => read("LOCAL_STATE_CLEANUP_PENDING", cleanupCodec),
    async writeLocalStateCleanupPending(row: LocalStateCleanupPendingRow) {
      const valid = cleanupCodec.validateForWrite(row);
      await table().put(valid as never);
      return valid;
    },
    async clearLocalStateCleanupPending() {
      await database.transaction("rw", database.table("storageMetadata"), async () => {
        if ((await read("LOCAL_STATE_CLEANUP_PENDING", cleanupCodec)) !== null) await table().delete("LOCAL_STATE_CLEANUP_PENDING");
      });
    },
  });
}
