import type { ClosedRowCodecRegistry } from "./closed-row-codecs";
import { LOGICAL_STORAGE_SCHEMA_VERSION } from "./storage-metadata";
import { StorageOperationError } from "./storage-failure";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "./table-catalogue";

/**
 * Closed dataset verification (storage-backup-spec 5.7, 7.5, 8.4, 8.7 step 1,
 * 9.4). It runs over a complete in-memory table set so the same invariants
 * guard launch, export, untrusted restore payloads and reconciliation.
 * Results name only a closed invariant and table; no row or value leaves.
 */

export const DATASET_INVARIANTS = Object.freeze([
  "ROW_SCHEMA",
  "REVISION_CHAIN",
  "HEAD_RESOLUTION",
  "TOMBSTONE_HEAD",
  "DELETED_CONTENT_RETAINED",
  "EVENT_SEQUENCE",
  "RECEIPT_REFERENCE",
  "WORK_REFERENCE",
  "CONSUMER_RECEIPT_REFERENCE",
  "DEPENDENCY_REFERENCE",
  "AUDIT_REFERENCE",
  "METADATA",
] as const);
export type DatasetInvariant = (typeof DATASET_INVARIANTS)[number];

export type DatasetTables = Record<JagaOnTableName, readonly unknown[]>;

export type DatasetVerification =
  | { kind: "VERIFIED"; eventSequenceHighWaterMark: number; highestEventSequence: number }
  | { kind: "FAILED"; invariant: DatasetInvariant; tableName: JagaOnTableName };

type Revision = { revisionId: string; recordId: string; recordType: string; revisionNumber: number; previousRevisionId: string | null; transactionId: string; auditEventId: string };
type Audit = { auditEventId: string; transactionId: string; recordId: string; recordType: string; previousRevisionId: string | null; resultingRevisionId: string | null; action: string };
type Head = { recordId: string; recordType: string; headRevisionId: string; headRevisionNumber: number; state: "ACTIVE" | "DELETED" };
type Tombstone = { recordId: string; recordType: string; auditEventId: string; transactionId: string };
type Event = { eventId: string; localSequence: number; commandId: string };
type Receipt = { commandId: string; outcome: string; transactionId?: string; domainEventIds?: string[]; auditEventIds?: string[] };

class InvariantFailure extends Error {
  constructor(
    readonly invariant: DatasetInvariant,
    readonly tableName: JagaOnTableName,
  ) {
    super(invariant);
  }
}

function fail(invariant: DatasetInvariant, tableName: JagaOnTableName): never {
  throw new InvariantFailure(invariant, tableName);
}

export function verifyDataset(
  tables: DatasetTables,
  registry: ClosedRowCodecRegistry,
  /**
   * `auditLinkage` adds the storage-backup-spec 8.4 audit/transaction linkage
   * invariant for restore candidates and targets: every revision and
   * tombstone names its own audit event in its own transaction, and every
   * receipt's audit events belong to the receipt's transaction and every
   * audit event to a receipt. Launch keeps the 5.7 set so an existing
   * dataset is never newly locked by this restore-only check.
   */
  options: { requireMetadata: boolean; auditLinkage?: boolean } = { requireMetadata: true },
): DatasetVerification {
  try {
    for (const table of JAGAON_TABLE_NAMES) {
      const rows = tables[table];
      if (!Array.isArray(rows)) fail("ROW_SCHEMA", table);
      for (const row of rows) {
        try {
          registry[table].validateAfterRead(row);
        } catch {
          fail("ROW_SCHEMA", table);
        }
      }
    }

    // Revision chains: contiguous numbers from 1 with exact previous links.
    const revisions = tables.recordRevisions as Revision[];
    const byRecord = new Map<string, Revision[]>();
    const revisionIds = new Set<string>();
    for (const revision of revisions) {
      if (revisionIds.has(revision.revisionId)) fail("REVISION_CHAIN", "recordRevisions");
      revisionIds.add(revision.revisionId);
      const chain = byRecord.get(revision.recordId) ?? [];
      chain.push(revision);
      byRecord.set(revision.recordId, chain);
    }
    for (const chain of byRecord.values()) {
      chain.sort((a, b) => a.revisionNumber - b.revisionNumber);
      chain.forEach((revision, index) => {
        const previous = chain[index - 1];
        if (revision.revisionNumber !== index + 1) fail("REVISION_CHAIN", "recordRevisions");
        if (revision.recordType !== chain[0]!.recordType) fail("REVISION_CHAIN", "recordRevisions");
        if ((previous?.revisionId ?? null) !== revision.previousRevisionId) fail("REVISION_CHAIN", "recordRevisions");
      });
    }

    // Heads resolve to their chain; deleted heads match exact tombstones and keep no content.
    const heads = tables.recordHeads as Head[];
    const tombstones = new Map((tables.deletionTombstones as Tombstone[]).map((row) => [row.recordId, row]));
    const headed = new Set<string>();
    for (const head of heads) {
      headed.add(head.recordId);
      const chain = byRecord.get(head.recordId);
      if (head.state === "ACTIVE") {
        const last = chain?.[chain.length - 1];
        if (!last || last.revisionId !== head.headRevisionId || last.revisionNumber !== head.headRevisionNumber || last.recordType !== head.recordType) {
          fail("HEAD_RESOLUTION", "recordHeads");
        }
        if (tombstones.has(head.recordId)) fail("TOMBSTONE_HEAD", "deletionTombstones");
      } else {
        const tombstone = tombstones.get(head.recordId);
        if (!tombstone || tombstone.recordType !== head.recordType) fail("TOMBSTONE_HEAD", "deletionTombstones");
        if (chain && chain.length > 0) fail("DELETED_CONTENT_RETAINED", "recordRevisions");
      }
    }
    for (const recordId of byRecord.keys()) if (!headed.has(recordId)) fail("HEAD_RESOLUTION", "recordHeads");
    for (const recordId of tombstones.keys()) if (!headed.has(recordId)) fail("TOMBSTONE_HEAD", "deletionTombstones");

    // Unique positive event sequences and a covering high-water mark.
    const events = tables.domainEvents as Event[];
    const sequences = new Set<number>();
    const eventIds = new Set<string>();
    let highestEventSequence = 0;
    for (const event of events) {
      if (sequences.has(event.localSequence) || eventIds.has(event.eventId)) fail("EVENT_SEQUENCE", "domainEvents");
      sequences.add(event.localSequence);
      eventIds.add(event.eventId);
      highestEventSequence = Math.max(highestEventSequence, event.localSequence);
    }
    const metadata = tables.storageMetadata as Array<{ key: string; lastAllocatedSequence?: number; logicalStorageSchemaVersion?: number }>;
    const highWater = metadata.find((row) => row.key === "EVENT_SEQUENCE_HIGH_WATER_MARK")?.lastAllocatedSequence ?? 0;
    if (highWater < highestEventSequence) fail("EVENT_SEQUENCE", "storageMetadata");

    // Every event belongs to a committed receipt that lists it, and vice versa.
    const receipts = new Map((tables.commandReceipts as Receipt[]).map((row) => [row.commandId, row]));
    for (const event of events) {
      const receipt = receipts.get(event.commandId);
      if (!receipt || receipt.outcome !== "COMMITTED" || !receipt.domainEventIds?.includes(event.eventId)) fail("RECEIPT_REFERENCE", "commandReceipts");
    }
    for (const receipt of receipts.values()) {
      for (const eventId of receipt.domainEventIds ?? []) if (!eventIds.has(eventId)) fail("RECEIPT_REFERENCE", "commandReceipts");
    }

    for (const item of tables.eventWorkItems as Array<{ eventId: string }>) if (!eventIds.has(item.eventId)) fail("WORK_REFERENCE", "eventWorkItems");
    for (const item of tables.eventConsumerReceipts as Array<{ eventId: string }>) {
      if (!eventIds.has(item.eventId)) fail("CONSUMER_RECEIPT_REFERENCE", "eventConsumerReceipts");
    }

    for (const edge of tables.reverseDependencies as Array<{ sourceRevisionId: string; dependentRevisionId: string; dependentRecordId: string }>) {
      if (!revisionIds.has(edge.sourceRevisionId) || !revisionIds.has(edge.dependentRevisionId)) fail("DEPENDENCY_REFERENCE", "reverseDependencies");
      if (!byRecord.get(edge.dependentRecordId)?.some((revision) => revision.revisionId === edge.dependentRevisionId)) {
        fail("DEPENDENCY_REFERENCE", "reverseDependencies");
      }
    }

    if (options.auditLinkage) {
      const audits = new Map((tables.auditEvents as Audit[]).map((row) => [row.auditEventId, row]));
      for (const revision of revisions) {
        const audit = audits.get(revision.auditEventId);
        if (
          !audit ||
          audit.resultingRevisionId !== revision.revisionId ||
          audit.recordId !== revision.recordId ||
          audit.recordType !== revision.recordType ||
          audit.previousRevisionId !== revision.previousRevisionId ||
          audit.transactionId !== revision.transactionId
        ) {
          fail("AUDIT_REFERENCE", "recordRevisions");
        }
      }
      for (const tombstone of tombstones.values()) {
        const audit = audits.get(tombstone.auditEventId);
        if (!audit || audit.recordId !== tombstone.recordId || audit.recordType !== tombstone.recordType || audit.transactionId !== tombstone.transactionId) {
          fail("AUDIT_REFERENCE", "deletionTombstones");
        }
      }
      const receipted = new Set<string>();
      for (const receipt of receipts.values()) {
        for (const auditEventId of receipt.auditEventIds ?? []) {
          if (audits.get(auditEventId)?.transactionId !== receipt.transactionId) fail("AUDIT_REFERENCE", "commandReceipts");
          receipted.add(auditEventId);
        }
      }
      for (const auditEventId of audits.keys()) if (!receipted.has(auditEventId)) fail("AUDIT_REFERENCE", "auditEvents");
    }

    if (options.requireMetadata) {
      const identity = metadata.find((row) => row.key === "DATABASE_IDENTITY");
      if (!identity || identity.logicalStorageSchemaVersion !== LOGICAL_STORAGE_SCHEMA_VERSION) fail("METADATA", "storageMetadata");
    }
    return { kind: "VERIFIED", eventSequenceHighWaterMark: highWater, highestEventSequence };
  } catch (error) {
    if (error instanceof InvariantFailure) return { kind: "FAILED", invariant: error.invariant, tableName: error.tableName };
    throw new StorageOperationError("STORAGE_INTEGRITY_FAILED");
  }
}
