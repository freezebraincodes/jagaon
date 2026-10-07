import { implementedStorageRowCodecs } from "./implemented-row-codecs";
import { storageMetadataRowCodec } from "./storage-metadata";
import { StorageRowValidationError, type StorageRowCodec } from "./storage-row-codec";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "./table-catalogue";

/**
 * Closed row-codec registry (Packet 10A Task 1; storage-backup-spec Sections
 * 2, 5.7 and 7.4). Every physical table has exactly one closed codec. Storage
 * owns the table-level codecs; the three multi-owner tables
 * (`recordRevisions`, `auditEvents`, `domainEvents`) are composed by the
 * application profile from each owner's exact schema, so storage never
 * imports application owners.
 */

export type ClosedRowCodecRegistry = { readonly [TTable in JagaOnTableName]: StorageRowCodec<unknown> };

export const OWNER_COMPOSED_TABLES = Object.freeze(["recordRevisions", "auditEvents", "domainEvents"] as const);
export type OwnerComposedTable = (typeof OWNER_COMPOSED_TABLES)[number];

/**
 * Tables no owner writes in the `HACKATHON_DEMO` profile; any row is invalid.
 * Packet 11A enables only `aiInvocationAudits`, with no index or version change.
 */
export const EMPTY_IN_PROFILE_TABLES = Object.freeze(["runtimeManifests", "governedAssets", "runtimeActivationAudits"] as const);
export type EmptyInProfileTable = (typeof EMPTY_IN_PROFILE_TABLES)[number];

/** A codec that accepts no row. */
export function emptyInProfileRowCodec(table: JagaOnTableName): StorageRowCodec<never> {
  return Object.freeze({
    validateForWrite(): never {
      throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", table, "WRITE");
    },
    validateAfterRead(): never {
      throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", table, "READ");
    },
  });
}

/**
 * Closed union of exact owner codecs: a row is valid only when one registered
 * member accepts it. A failure carries no member issue or value.
 */
export function createUnionRowCodec<T>(table: JagaOnTableName, members: readonly StorageRowCodec<T>[]): StorageRowCodec<T> {
  if (members.length === 0) return emptyInProfileRowCodec(table);
  const frozen = Object.freeze([...members]);
  function attempt(value: unknown, boundary: "WRITE" | "READ"): T {
    for (const member of frozen) {
      try {
        return boundary === "WRITE" ? member.validateForWrite(value) : member.validateAfterRead(value);
      } catch {
        // Try the next closed member; nothing about the rejection is kept.
      }
    }
    throw new StorageRowValidationError(boundary === "WRITE" ? "STORAGE_VALIDATION_FAILED" : "STORAGE_INTEGRITY_FAILED", table, boundary);
  }
  return Object.freeze({
    validateForWrite: (value: unknown) => attempt(value, "WRITE"),
    validateAfterRead: (value: unknown) => attempt(value, "READ"),
  });
}

/** Storage-owned closed codecs for the 13 tables storage defines itself. */
export const STORAGE_OWNED_CLOSED_CODECS: Readonly<Omit<ClosedRowCodecRegistry, OwnerComposedTable>> = Object.freeze({
  appPreferences: implementedStorageRowCodecs.appPreferences,
  recordHeads: implementedStorageRowCodecs.recordHeads,
  deletionTombstones: implementedStorageRowCodecs.deletionTombstones,
  commandReceipts: implementedStorageRowCodecs.commandReceipts,
  eventWorkItems: implementedStorageRowCodecs.eventWorkItems,
  eventConsumerReceipts: implementedStorageRowCodecs.eventConsumerReceipts,
  reverseDependencies: implementedStorageRowCodecs.reverseDependencies,
  engineEvaluationAudits: implementedStorageRowCodecs.engineEvaluationAudits,
  aiInvocationAudits: implementedStorageRowCodecs.aiInvocationAudits,
  runtimeManifests: emptyInProfileRowCodec("runtimeManifests"),
  governedAssets: emptyInProfileRowCodec("governedAssets"),
  runtimeActivationAudits: emptyInProfileRowCodec("runtimeActivationAudits"),
  storageMetadata: storageMetadataRowCodec,
});

/** Assembles the complete registry; every one of the 16 tables must be present. */
export function createClosedRowCodecRegistry(composed: Readonly<Record<OwnerComposedTable, StorageRowCodec<unknown>>>): ClosedRowCodecRegistry {
  const registry = { ...STORAGE_OWNED_CLOSED_CODECS, ...composed } as Record<string, StorageRowCodec<unknown>>;
  const keys = Object.keys(registry).sort();
  const expected = [...JAGAON_TABLE_NAMES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "storageMetadata", "READ");
  }
  return Object.freeze(registry) as ClosedRowCodecRegistry;
}

/** Validates one stored row through the registry's exact table codec. */
export function validateClosedStoredRow(registry: ClosedRowCodecRegistry, table: JagaOnTableName, value: unknown): unknown {
  const codec = registry[table];
  if (!codec) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", table, "READ");
  return codec.validateAfterRead(value);
}
