import { canonicalizeJson, hashCanonicalJson } from "@/application/contracts/canonical-json";
import { databaseIdentityRow, LOGICAL_STORAGE_SCHEMA_VERSION, migrationStateRowSchema, storageMetadataRowCodec } from "../storage-metadata";
import { StorageOperationError } from "../storage-failure";
import { JAGAON_DEXIE_VERSION } from "../table-catalogue";
import type { MigrationContext, RegisteredStorageMigration, StorageMigrationDefinition } from "./migration-contracts";

/**
 * The closed, ordered storage-migration registry (storage-backup-spec 5.2;
 * Packet 10 freeze Section 5). Selection is never supplied by AI, downloaded,
 * inferred from rows or chosen by the UI.
 */

export const LEGACY_DATASET_IDENTITY_MIGRATION_ID = "jagaon.storage.0001-legacy-dataset-identity";

const legacyIdentityDefinition: Readonly<StorageMigrationDefinition> = Object.freeze({
  migrationId: LEGACY_DATASET_IDENTITY_MIGRATION_ID,
  fromDexieVersion: 1,
  toDexieVersion: 2,
  fromLogicalSchemaVersion: 0,
  toLogicalSchemaVersion: 1,
  implementationVersion: "10a.1",
  affectedTables: Object.freeze(["storageMetadata"]) as unknown as StorageMigrationDefinition["affectedTables"],
  changesPatientContent: false,
  requiresExplicitRecomputation: false,
});

/**
 * 0001: a Packet 9 database (Dexie 1, no identity) receives a new random
 * local dataset identity at logical version 1. No patient row is read for
 * meaning, transformed, defaulted or dropped; every row must already validate
 * through the closed registry or the version change aborts.
 */
async function bootstrapLegacyIdentity(context: MigrationContext): Promise<void> {
  const { transaction, inputs, fault } = context;
  if (fault === "BEFORE_TRANSFORM") throw new StorageOperationError("MIGRATION_VALIDATION_FAILED");
  const metadata = transaction.table("storageMetadata");
  const existing = (await metadata.toArray()) as Array<{ key?: unknown }>;
  for (const row of existing) storageMetadataRowCodec.validateAfterRead(row);
  if (existing.some((row) => row.key === "DATABASE_IDENTITY" || row.key === "MIGRATION_STATE" || row.key === "RESTORE_STATE")) {
    // A legacy database never held these keys; their presence is corruption.
    throw new StorageOperationError("MIGRATION_VALIDATION_FAILED", { tableName: "storageMetadata" });
  }
  await metadata.add(
    databaseIdentityRow({ datasetIdentity: inputs.datasetIdentity, createdAt: inputs.at, lastCompletedMigrationId: LEGACY_DATASET_IDENTITY_MIGRATION_ID }) as never,
  );
  if (fault === "AFTER_IDENTITY") throw new StorageOperationError("MIGRATION_VALIDATION_FAILED");
  await metadata.add(
    migrationStateRowSchema.parse({
      key: "MIGRATION_STATE",
      phase: "COMPLETED",
      migrationId: LEGACY_DATASET_IDENTITY_MIGRATION_ID,
      fromDexieVersion: legacyIdentityDefinition.fromDexieVersion,
      toDexieVersion: legacyIdentityDefinition.toDexieVersion,
      fromLogicalSchemaVersion: legacyIdentityDefinition.fromLogicalSchemaVersion,
      toLogicalSchemaVersion: legacyIdentityDefinition.toLogicalSchemaVersion,
      implementationVersion: legacyIdentityDefinition.implementationVersion,
      startedAt: inputs.at,
      completedAt: inputs.at,
      lastCompletedStep: "VERIFY",
    }) as never,
  );
  if (fault === "AFTER_STATE") throw new StorageOperationError("MIGRATION_VALIDATION_FAILED");
  if (fault === "DURING_VERIFY") throw new StorageOperationError("MIGRATION_VALIDATION_FAILED");
  await context.verifyAllRows(transaction);
}

export const STORAGE_MIGRATION_REGISTRY: readonly RegisteredStorageMigration[] = Object.freeze([
  Object.freeze({
    definition: legacyIdentityDefinition,
    definitionSha256: "13dcf835d11f08d27b58eb1eaabc5cd09ba98ad4ac36c9edff129bdd474d7302",
    transform: bootstrapLegacyIdentity,
  }),
]);

export const CURRENT_STORAGE_VERSIONS = Object.freeze({ dexie: JAGAON_DEXIE_VERSION, logical: LOGICAL_STORAGE_SCHEMA_VERSION });

function definitionMaterial(definition: Readonly<StorageMigrationDefinition>): unknown {
  const material: Record<string, unknown> = { ...definition, affectedTables: [...definition.affectedTables] };
  if (material.expectedPreviousMigrationId === undefined) delete material.expectedPreviousMigrationId;
  return material;
}

/** Fails closed on unknown, duplicated, out-of-order or checksum-mismatched definitions. */
export async function verifyMigrationRegistry(registry: readonly RegisteredStorageMigration[]): Promise<void> {
  const ids = new Set<string>();
  let previous: Readonly<StorageMigrationDefinition> | null = null;
  for (const entry of registry) {
    const definition = entry.definition;
    if (ids.has(definition.migrationId)) throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
    ids.add(definition.migrationId);
    if (definition.toDexieVersion <= definition.fromDexieVersion || definition.toLogicalSchemaVersion <= definition.fromLogicalSchemaVersion) {
      // Downgrades and in-place history edits are never registered migrations.
      throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
    }
    if (previous !== null) {
      if (definition.fromDexieVersion !== previous.toDexieVersion || definition.fromLogicalSchemaVersion !== previous.toLogicalSchemaVersion) {
        throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
      }
      if (definition.expectedPreviousMigrationId !== previous.migrationId) throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
    } else if (definition.expectedPreviousMigrationId !== undefined) {
      throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
    }
    canonicalizeJson(definitionMaterial(definition));
    const digest = await hashCanonicalJson(definitionMaterial(definition));
    if (digest !== entry.definitionSha256) throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
    previous = definition;
  }
}

/**
 * Resolves the unique contiguous chain from the stored versions to the
 * application's versions. An empty chain means no migration is required.
 */
export function resolveMigrationChain(
  registry: readonly RegisteredStorageMigration[],
  from: { dexie: number; logical: number; lastCompletedMigrationId?: string },
  to: { dexie: number; logical: number } = CURRENT_STORAGE_VERSIONS,
): RegisteredStorageMigration[] {
  if (from.dexie > to.dexie || from.logical > to.logical) {
    throw new StorageOperationError("DATABASE_VERSION_UNSUPPORTED", { storedVersion: from.logical, supportedVersion: to.logical });
  }
  const chain: RegisteredStorageMigration[] = [];
  let dexie = from.dexie;
  let logical = from.logical;
  let lastId = from.lastCompletedMigrationId;
  while (dexie !== to.dexie || logical !== to.logical) {
    const candidates = registry.filter((entry) => entry.definition.fromDexieVersion === dexie && entry.definition.fromLogicalSchemaVersion === logical);
    if (candidates.length !== 1) throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE", { storedVersion: logical, supportedVersion: to.logical });
    const next = candidates[0]!;
    if (lastId !== undefined && next.definition.expectedPreviousMigrationId !== undefined && next.definition.expectedPreviousMigrationId !== lastId) {
      throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
    }
    chain.push(next);
    dexie = next.definition.toDexieVersion;
    logical = next.definition.toLogicalSchemaVersion;
    lastId = next.definition.migrationId;
    if (dexie > to.dexie || logical > to.logical) throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE");
  }
  return chain;
}
