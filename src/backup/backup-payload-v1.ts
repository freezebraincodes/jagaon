import { z } from "zod";
import { instantSchema, type Instant } from "@/domain/shared/time";
import { containerIdSchema, datasetIdentitySchema, migrationIdSchema } from "@/storage/storage-metadata";
import type { JagaOnTableName } from "@/storage/table-catalogue";

/**
 * Note (Packet 11C C2 fix round 1, M-7): despite its file name, this module now defines BOTH payload versions: the locked version 1
 * and the current version 2 (`backupPayloadV2Schema`, `BackupPayloadV2`). The table set and table envelope are still the version 1 ones.
 *
 * Locked version 1 encrypted payload (storage-backup-spec 7.4). Rows inside
 * `tables` are validated through the closed profile row-codec registry, never
 * as generic JSON; this schema closes the envelope, manifest and table set.
 *
 * Packet 11C Addendum C, Task C2 (hybrid spec D11): payload version 2 is
 * version 1 plus one closed, required field, `patientSettings`, carrying the
 * patient's "Keep wording on this device" setting (the device's
 * `appPreferences` table stays excluded). The table set, table envelope
 * (version 1), manifests and container are unchanged. Export writes version 2;
 * a version 1 backup (no field) is migrated in memory by the registered
 * 1 → 2 step with the setting off (backup-migration-registry.ts), and an
 * older application refuses a version 2 backup as BACKUP_VERSION_UNSUPPORTED.
 */

export const BACKUP_PAYLOAD_FORMAT = "jagaon-backup-payload" as const;
/** The first payload version (no patient settings). */
export const BACKUP_SCHEMA_VERSION_V1 = 1 as const;
/** The current payload version written by export and targeted by migration (Packet 11C C2). */
export const BACKUP_SCHEMA_VERSION = 2 as const;
export const CANONICAL_JSON_PROFILE = "JAGAON_CANONICAL_JSON_V1" as const;
export const TABLE_ENVELOPE_SCHEMA_VERSION = 1 as const;

export const BACKUP_TABLE_NAMES_V1 = Object.freeze([
  "recordRevisions",
  "recordHeads",
  "deletionTombstones",
  "auditEvents",
  "domainEvents",
  "commandReceipts",
  "eventWorkItems",
  "eventConsumerReceipts",
  "reverseDependencies",
  "engineEvaluationAudits",
  "aiInvocationAudits",
  "runtimeManifests",
  "governedAssets",
  "runtimeActivationAudits",
] as const satisfies readonly JagaOnTableName[]);
export type BackupTableNameV1 = (typeof BACKUP_TABLE_NAMES_V1)[number];

/** Canonical primary key of each included table (its Dexie key path). */
export const BACKUP_PRIMARY_KEYS: Readonly<Record<BackupTableNameV1, readonly string[]>> = Object.freeze({
  recordRevisions: ["revisionId"],
  recordHeads: ["recordId"],
  deletionTombstones: ["recordId"],
  auditEvents: ["auditEventId"],
  domainEvents: ["eventId"],
  commandReceipts: ["commandId"],
  eventWorkItems: ["workItemId"],
  eventConsumerReceipts: ["eventId", "consumer", "handlerVersion"],
  reverseDependencies: ["sourceRevisionId", "dependentRevisionId", "dependencyRole"],
  engineEvaluationAudits: ["evaluationId"],
  aiInvocationAudits: ["requestId"],
  runtimeManifests: ["manifestId", "manifestVersion"],
  governedAssets: ["assetKey", "assetVersion"],
  runtimeActivationAudits: ["activationAuditId"],
});

export type BackupTableManifest = {
  tableName: BackupTableNameV1;
  tableEnvelopeSchemaVersion: number;
  rowCount: number;
  canonicalRowsSha256: string;
};

export type BackupRequestedRuntimePointer =
  | { runtimeKind: "DETERMINISTIC"; manifestId: string; manifestVersion: string }
  | { runtimeKind: "AI_TASK"; taskType: string; bundleId: string; bundleVersion: string };

export type BackupTableSetV1 = { [K in BackupTableNameV1]: unknown[] };

export type BackupPayloadV1 = {
  format: typeof BACKUP_PAYLOAD_FORMAT;
  backupSchemaVersion: typeof BACKUP_SCHEMA_VERSION_V1;
  containerId: string;
  datasetIdentity: string;
  exportedAt: Instant;
  sourceApplicationVersion: string;
  sourceDexieVersion: number;
  sourceLogicalStorageSchemaVersion: number;
  canonicalJsonProfile: typeof CANONICAL_JSON_PROFILE;
  eventSequenceHighWaterMark: number;
  lastCompletedMigrationId?: string;
  requestedRuntimePointers: BackupRequestedRuntimePointer[];
  tableManifests: BackupTableManifest[];
  tables: BackupTableSetV1;
};

/** Packet 11C Addendum C (C2): the patient settings a version 2 payload carries (closed; no health truth, identifier or provider field). */
export type BackupPatientSettings = { keepWordingOnDevice: boolean };

/** Packet 11C Addendum C (C2): the current payload, version 1 plus the closed `patientSettings`. */
export type BackupPayloadV2 = Omit<BackupPayloadV1, "backupSchemaVersion"> & {
  backupSchemaVersion: typeof BACKUP_SCHEMA_VERSION;
  patientSettings: BackupPatientSettings;
};

const tableNameSchema = z.enum(BACKUP_TABLE_NAMES_V1 as unknown as [BackupTableNameV1, ...BackupTableNameV1[]]);

export const backupTableManifestSchema = z.strictObject({
  tableName: tableNameSchema,
  tableEnvelopeSchemaVersion: z.literal(TABLE_ENVELOPE_SCHEMA_VERSION),
  rowCount: z.number().int().nonnegative().safe(),
  canonicalRowsSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The hackathon profile installs no runtime pointer, so none is accepted. */
const requestedRuntimePointerSchema = z.never();

/** The envelope fields both payload versions share (everything except the version and, in version 2, the patient settings). */
const sharedPayloadShape = {
  format: z.literal(BACKUP_PAYLOAD_FORMAT),
  containerId: containerIdSchema,
  datasetIdentity: datasetIdentitySchema,
  exportedAt: instantSchema,
  sourceApplicationVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  sourceDexieVersion: z.number().int().positive().safe(),
  sourceLogicalStorageSchemaVersion: z.number().int().positive().safe(),
  canonicalJsonProfile: z.literal(CANONICAL_JSON_PROFILE),
  eventSequenceHighWaterMark: z.number().int().nonnegative().safe(),
  lastCompletedMigrationId: migrationIdSchema.optional(),
  requestedRuntimePointers: z.array(requestedRuntimePointerSchema),
  tableManifests: z.array(backupTableManifestSchema).length(BACKUP_TABLE_NAMES_V1.length),
  tables: z.strictObject(Object.fromEntries(BACKUP_TABLE_NAMES_V1.map((name) => [name, z.array(z.unknown())])) as Record<BackupTableNameV1, z.ZodArray<z.ZodUnknown>>),
};

function refineEnvelope(payload: { lastCompletedMigrationId?: string; tableManifests: Array<{ tableName: string }> }, ctx: z.RefinementCtx) {
  if (Object.prototype.hasOwnProperty.call(payload, "lastCompletedMigrationId") && payload.lastCompletedMigrationId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OPTIONAL_FIELD_MUST_BE_ABSENT" });
  }
  payload.tableManifests.forEach((manifest, index) => {
    if (manifest.tableName !== BACKUP_TABLE_NAMES_V1[index]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "MANIFEST_ORDER" });
  });
}

/** Version 1, exactly as Packet 10 wrote it (kept for old backups; never written any more). */
export const backupPayloadV1Schema = z
  .strictObject({ ...sharedPayloadShape, backupSchemaVersion: z.literal(BACKUP_SCHEMA_VERSION_V1) })
  .superRefine(refineEnvelope);

/** Packet 11C Addendum C (C2): the closed patient settings of a version 2 payload. */
export const backupPatientSettingsSchema = z.strictObject({ keepWordingOnDevice: z.boolean() });

/** Packet 11C Addendum C (C2): version 2, the current payload (version 1 plus the required, closed `patientSettings`). */
export const backupPayloadV2Schema = z
  .strictObject({ ...sharedPayloadShape, backupSchemaVersion: z.literal(BACKUP_SCHEMA_VERSION), patientSettings: backupPatientSettingsSchema })
  .superRefine(refineEnvelope);
