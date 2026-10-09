import { aiAuditsAffectedByDeletion, validateAiAuditReferences } from "@/application/ai/ai-audit-lifecycle";
import { canonicalizeJson, hashCanonicalJson, type Sha256Digest } from "@/application/contracts/canonical-json";
import { frozenClone } from "@/application/deep-freeze";
import { isJournalSourceEventName, JOURNAL_DELETED_EVENT_PAYLOAD } from "@/application/journal/journal-stored-rows";
import { neutralisedCommandHash } from "@/application/deletion/deletion-planner";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import { canonicaliseBackupTable } from "@/backup/backup-canonicalisation";
import { BACKUP_TABLE_NAMES_V1, type BackupTableSetV1 } from "@/backup/backup-payload-v1";
import type { ValidatedBackupCandidate } from "@/backup/backup-restore-validator";
import type { Instant } from "@/domain/shared/time";
import { verifyDataset, type DatasetTables } from "@/storage/dataset-verifier";
import { StorageOperationError } from "@/storage/storage-failure";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "@/storage/table-catalogue";
import type { RestoreMode } from "@/storage/storage-metadata";
import { validateReverseDependencies } from "./dependency-reconstruction";
import { RESTORE_PLAN_TTL_MS, type RestorePlan, type RestorePlanCounts } from "./restore-contracts";

/**
 * Restore planning (storage-backup-spec 8.1, 8.5, 8.6 overlay; RST-001–
 * RST-006). The plan compares the validated candidate with one consistent
 * read of the current database:
 * - an empty database adopts the backup identity;
 * - the same lineage is replaced, with every current tombstone and its
 *   minimum ledger closure preserved over older backup content;
 * - a different non-empty lineage is refused.
 */

type Row = Record<string, unknown>;
const ids = (rows: readonly unknown[], field: string) => new Set((rows as Row[]).map((row) => row[field] as string));

/**
 * Canonical material for the exact current dataset (Corrective Pass A item 6):
 * every row of every canonical, ledger, work, dependency, audit, governed and
 * metadata table, in IndexedDB primary-key order. Any content change, even
 * with unchanged counts, makes a restore plan stale. Only the rebuildable
 * `appPreferences` projection is excluded; restore replaces it anyway.
 */
export function currentDatasetFingerprint(tables: Readonly<Record<string, readonly unknown[]>>): string {
  return canonicalizeJson(Object.fromEntries(JAGAON_TABLE_NAMES.filter((name) => name !== "appPreferences").map((name) => [name, tables[name] ?? []])));
}

/** SHA-256 of the canonical post-overlay target dataset. */
export function restoreTargetDigest(target: unknown): Promise<Sha256Digest> {
  return hashCanonicalJson(target);
}

/** Every field a confirmation commits, exactly as reviewed. */
export function restorePlanMaterial(plan: Omit<RestorePlan, "planHash" | "target">): unknown {
  return {
    profile: "JAGAON_RESTORE_PLAN_V2",
    operationId: plan.operationId,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    mode: plan.mode,
    containerId: plan.containerId,
    datasetIdentity: plan.datasetIdentity,
    sourceBackupSchemaVersion: plan.sourceBackupSchemaVersion,
    currentFingerprint: plan.currentFingerprint,
    payloadFingerprint: plan.payloadFingerprint,
    targetDigest: plan.targetDigest,
    effects: plan.effects,
  };
}

export function restorePlanHash(material: unknown): Promise<Sha256Digest> {
  return hashCanonicalJson(material);
}

/** Bootstrap-only empty: no canonical, ledger, work or audit row (spec 8.1). */
export function isEmptyDataset(tables: DatasetTables): boolean {
  const ledger: JagaOnTableName[] = ["recordRevisions", "recordHeads", "deletionTombstones", "auditEvents", "domainEvents", "commandReceipts", "eventWorkItems", "eventConsumerReceipts", "reverseDependencies", "engineEvaluationAudits", "aiInvocationAudits"];
  return ledger.every((table) => tables[table].length === 0);
}

function countActive(tables: BackupTableSetV1, types: readonly string[]): number {
  return (tables.recordHeads as Array<{ recordType: string; state: string }>).filter((head) => head.state === "ACTIVE" && types.includes(head.recordType)).length;
}

export function restoreCounts(tables: BackupTableSetV1): RestorePlanCounts {
  return {
    glucoseReadings: countActive(tables, ["GLUCOSE_READING"]),
    medicineEntries: countActive(tables, ["MEDICATION_EVENT"]),
    mealEntries: countActive(tables, ["INTAKE_EVENT"]),
    healthChecksAppointments: countActive(tables, ["PREVENTIVE_CARE_ITEM", "APPOINTMENT"]),
  };
}

function isRedacted(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Object.keys(payload).length === 1 && (payload as { reasonCode?: unknown }).reasonCode === JOURNAL_DELETED_EVENT_PAYLOAD.reasonCode;
}

/**
 * Same-lineage deletion-protection overlay (spec 6.7, 8.6; RST-004). For
 * each current tombstone the backup does not already contain, the backup's
 * revisions, edges, engine and AI audits and copied event payloads for that record
 * are removed, its receipts are neutralised, and only the minimum deletion
 * ledger (head, tombstone, audit, event, receipts, work) is carried over.
 * Overlapping identities must be byte-equivalent; a conflict is corruption.
 */
export async function applyDeletionOverlay(backup: BackupTableSetV1, current: DatasetTables): Promise<{ tables: BackupTableSetV1; protectedDeletions: number }> {
  const target = structuredClone(backup) as Record<string, Row[]>;
  const backupTombstones = ids(backup.deletionTombstones, "recordId");
  const protectedTombstones = (current.deletionTombstones as Row[]).filter((row) => !backupTombstones.has(row.recordId as string));
  if (protectedTombstones.length === 0) return { tables: backup, protectedDeletions: 0 };

  const purged = new Set(protectedTombstones.map((row) => row.recordId as string));
  const transactions = new Set(protectedTombstones.map((row) => row.transactionId as string));
  const purgedRevisions = new Set(target.recordRevisions!.filter((row) => purged.has(row.recordId as string)).map((row) => row.revisionId as string));

  target.recordRevisions = target.recordRevisions!.filter((row) => !purged.has(row.recordId as string));
  target.reverseDependencies = target.reverseDependencies!.filter((row) => !purged.has(row.dependentRecordId as string) && !purgedRevisions.has(row.sourceRevisionId as string));
  target.engineEvaluationAudits = target.engineEvaluationAudits!.filter(
    (row) => ![...(row.triggeringRevisions as Row[]), ...(row.consideredRevisions as Row[])].some((ref) => purgedRevisions.has(ref.revisionId as string)),
  );
  // An older AI audit naming a later-deleted record is never resurrected (spec 6.6, 6.7).
  const removedAudits = new Set(aiAuditsAffectedByDeletion(target.aiInvocationAudits!, { recordIds: purged, revisionIds: purgedRevisions }));
  target.aiInvocationAudits = target.aiInvocationAudits!.filter((row) => !removedAudits.has(row.requestId as string));
  for (const event of target.domainEvents!) {
    const change = event.change as Row;
    if (purged.has(change.recordId as string) && isJournalSourceEventName(event.eventName as string) && !isRedacted(event.payload)) event.payload = { ...JOURNAL_DELETED_EVENT_PAYLOAD };
  }
  for (const receipt of target.commandReceipts!) {
    const refs = [...((receipt.resultingRevisions as Row[]) ?? []), ...((receipt.existingRevisions as Row[]) ?? []), ...((receipt.currentHeads as Row[]) ?? [])];
    if (refs.some((ref) => purged.has(ref.recordId as string))) receipt.commandHash = await neutralisedCommandHash(receipt.commandId as string);
  }

  // Carry over the minimum deletion ledger from the current dataset.
  const currentHeads = new Map((current.recordHeads as Row[]).map((row) => [row.recordId as string, row]));
  target.recordHeads = target.recordHeads!.filter((row) => !purged.has(row.recordId as string));
  for (const recordId of purged) {
    const head = currentHeads.get(recordId);
    if (!head) throw new StorageOperationError("STORAGE_CORRUPTION_DETECTED", { tableName: "recordHeads" });
    target.recordHeads.push(head);
  }
  target.deletionTombstones = [...target.deletionTombstones!, ...protectedTombstones];

  const ledgerEvents = (current.domainEvents as Row[]).filter((row) => transactions.has(row.transactionId as string));
  const ledgerEventIds = new Set(ledgerEvents.map((row) => row.eventId as string));
  const ledgerCommands = new Set(ledgerEvents.map((row) => row.commandId as string));
  const carry = (table: JagaOnTableName, rows: Row[], key: (row: Row) => string) => {
    const existing = new Map(target[table]!.map((row) => [key(row), row]));
    for (const row of rows) {
      const already = existing.get(key(row));
      if (already) {
        if (canonicalizeJson(already) !== canonicalizeJson(row)) throw new StorageOperationError("STORAGE_CORRUPTION_DETECTED", { tableName: table });
        continue;
      }
      target[table]!.push(row);
    }
  };
  carry("auditEvents", (current.auditEvents as Row[]).filter((row) => transactions.has(row.transactionId as string)), (row) => row.auditEventId as string);
  carry("domainEvents", ledgerEvents, (row) => row.eventId as string);
  carry("commandReceipts", (current.commandReceipts as Row[]).filter((row) => ledgerCommands.has(row.commandId as string)), (row) => row.commandId as string);
  carry("eventWorkItems", (current.eventWorkItems as Row[]).filter((row) => ledgerEventIds.has(row.eventId as string)), (row) => row.workItemId as string);
  carry(
    "eventConsumerReceipts",
    (current.eventConsumerReceipts as Row[]).filter((row) => ledgerEventIds.has(row.eventId as string)),
    (row) => `${row.eventId}|${row.consumer}|${row.handlerVersion}`,
  );
  const sequences = new Map<number, string>();
  for (const event of target.domainEvents!) {
    const other = sequences.get(event.localSequence as number);
    if (other !== undefined && other !== event.eventId) throw new StorageOperationError("STORAGE_CORRUPTION_DETECTED", { tableName: "domainEvents" });
    sequences.set(event.localSequence as number, event.eventId as string);
  }

  const tables = Object.fromEntries(BACKUP_TABLE_NAMES_V1.map((name) => [name, canonicaliseBackupTable(name, target[name]!)])) as BackupTableSetV1;
  return { tables, protectedDeletions: protectedTombstones.length };
}

/**
 * Pre-destructive target verification (storage-backup-spec 8.4–8.6): every
 * closed dataset invariant, the exact reverse-dependency set and the exact
 * AI audit reference closure (Packet 11A). The planner,
 * the confirmation pre-check and the replacement transaction all call this one
 * function before any row is cleared or written.
 */
export function verifyRestoreTarget(
  target: { tables: Readonly<Record<string, readonly unknown[]>>; eventSequenceHighWaterMark: number },
  now: Instant,
): { kind: "VERIFIED" } | { kind: "FAILED"; tableName: JagaOnTableName } {
  const verification = verifyDataset(
    { ...Object.fromEntries(JAGAON_TABLE_NAMES.map((name) => [name, []])), ...target.tables, storageMetadata: [{ key: "EVENT_SEQUENCE_HIGH_WATER_MARK", lastAllocatedSequence: target.eventSequenceHighWaterMark, updatedAt: now }] } as unknown as DatasetTables,
    HACKATHON_CLOSED_ROW_CODECS,
    { requireMetadata: false, auditLinkage: true },
  );
  if (verification.kind === "FAILED") return { kind: "FAILED", tableName: verification.tableName };
  if (validateReverseDependencies(target.tables.recordRevisions ?? [], target.tables.reverseDependencies ?? []).kind !== "VALID") return { kind: "FAILED", tableName: "reverseDependencies" };
  if (validateAiAuditReferences({ recordRevisions: target.tables.recordRevisions ?? [], aiInvocationAudits: target.tables.aiInvocationAudits ?? [] }).kind !== "VALID") return { kind: "FAILED", tableName: "aiInvocationAudits" };
  return { kind: "VERIFIED" };
}

export async function buildRestorePlan(input: {
  candidate: ValidatedBackupCandidate;
  current: DatasetTables;
  now: Instant;
  operationId: string;
}): Promise<RestorePlan> {
  const { candidate, current, now } = input;
  const metadata = current.storageMetadata as Array<{ key: string; datasetIdentity?: string; lastAllocatedSequence?: number }>;
  const currentIdentity = metadata.find((row) => row.key === "DATABASE_IDENTITY")?.datasetIdentity;
  const empty = isEmptyDataset(current);
  const mode: RestoreMode | null = empty ? "RESTORE_INTO_EMPTY_DATABASE" : currentIdentity === candidate.datasetIdentity ? "REPLACE_SAME_LINEAGE_DATABASE" : null;
  if (mode === null) throw new StorageOperationError("BACKUP_LINEAGE_MISMATCH");

  let tables = candidate.tables;
  let protectedDeletions = 0;
  let newerRecordsDiscarded = 0;
  let highWater = Math.max(candidate.eventSequenceHighWaterMark, candidate.highestEventSequence);
  if (mode === "REPLACE_SAME_LINEAGE_DATABASE") {
    const overlay = await applyDeletionOverlay(candidate.tables, current);
    tables = overlay.tables;
    protectedDeletions = overlay.protectedDeletions;
    const backupRecords = ids(candidate.tables.recordHeads, "recordId");
    newerRecordsDiscarded = (current.recordHeads as Array<{ recordId: string; state: string }>).filter((head) => head.state === "ACTIVE" && !backupRecords.has(head.recordId)).length;
    const currentHighWater = metadata.find((row) => row.key === "EVENT_SEQUENCE_HIGH_WATER_MARK")?.lastAllocatedSequence ?? 0;
    highWater = Math.max(highWater, currentHighWater, ...(tables.domainEvents as Array<{ localSequence: number }>).map((event) => event.localSequence));
  }

  // The complete target must satisfy every invariant before it can be confirmed.
  const verification = verifyRestoreTarget({ tables, eventSequenceHighWaterMark: highWater }, now);
  if (verification.kind === "FAILED") throw new StorageOperationError("STORAGE_INTEGRITY_FAILED", { tableName: verification.tableName });

  const currentFingerprint = currentDatasetFingerprint(current);
  const expiresAt = new Date(Date.parse(now) + RESTORE_PLAN_TTL_MS).toISOString() as Instant;
  const target = {
    tables,
    eventSequenceHighWaterMark: highWater,
    ...(candidate.lastCompletedMigrationId ? { lastCompletedMigrationId: candidate.lastCompletedMigrationId } : {}),
    // Packet 11C Addendum C (C2): the backup's patient settings, bound into the target digest and plan hash (the commit combines them
    // with the device's current value: fix round 1, I-2).
    patientSettings: { keepWordingOnDevice: candidate.patientSettings.keepWordingOnDevice === true },
  };
  const material = {
    operationId: input.operationId,
    createdAt: now,
    expiresAt,
    mode,
    containerId: candidate.containerId,
    datasetIdentity: candidate.datasetIdentity,
    sourceBackupSchemaVersion: candidate.sourceBackupSchemaVersion,
    currentFingerprint,
    payloadFingerprint: candidate.payloadFingerprint,
    targetDigest: await restoreTargetDigest(target),
    effects: {
      exportedAt: candidate.exportedAt,
      counts: restoreCounts(tables),
      newerRecordsDiscarded,
      protectedDeletions,
      runtimePointersReplaced: 0 as const,
      externalCopiesUnchanged: true as const,
    },
  };
  const planHash = await restorePlanHash(restorePlanMaterial(material));
  // The caller receives a deep, frozen copy that shares nothing with internal state.
  return frozenClone({ ...material, planHash, target });
}
