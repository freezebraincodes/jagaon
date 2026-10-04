import type { Table } from "dexie";
import type { CommandReceipt } from "@/application/contracts";
import type { RecordId } from "@/domain/shared";
import type { StorageRowCodec } from "./storage-row-codec";

/**
 * Permanent-deletion effects applied inside the authoritative transaction
 * (storage-backup-spec 6.5 steps 1, 4, 5 and 7; 6.6). The application
 * planner supplies the exact closure; this module re-checks it against rows
 * read inside the same write transaction, then removes patient-content
 * revisions, prohibited copies and obsolete edges. All of it commits with the
 * tombstones, heads, audits, events and receipt, or none of it does.
 */

/** Rows read inside the write transaction for the closure re-check. */
export type PermanentDeletionSnapshot = {
  recordHeads: readonly unknown[];
  recordRevisions: readonly unknown[];
  reverseDependencies: readonly unknown[];
  engineEvaluationAudits: readonly unknown[];
  commandReceipts: readonly unknown[];
  domainEvents: readonly unknown[];
};

export type PermanentDeletionEffects = {
  /** Every logical record whose patient-content revisions are removed. */
  purgedRecordIds: readonly RecordId[];
  /** Engine evaluation audits that name a purged revision (6.6). */
  removedEvaluationIds: readonly string[];
  /** Existing events whose payload copies deleted content get this closed replacement payload. */
  redactedEvents: readonly { eventId: string; payload: unknown }[];
  /** Receipts whose content-derived hash would remain a reversible fingerprint. */
  neutralisedReceipts: readonly { commandId: string; commandHash: string }[];
  /** Pure re-check of the planned closure; `false` aborts with no effect. */
  closureUnchanged(snapshot: PermanentDeletionSnapshot): boolean;
};

export class DeletionClosureChangedError extends Error {
  readonly name = "DeletionClosureChangedError";
  constructor() {
    super("Permanent-deletion closure changed");
  }
}

export type PermanentDeletionTables = {
  heads: Table<unknown>;
  revisions: Table<unknown>;
  dependencies: Table<unknown>;
  evaluations: Table<unknown>;
  receipts: Table<CommandReceipt>;
  events: Table<unknown>;
};

export async function applyPermanentDeletion(
  tables: PermanentDeletionTables,
  effects: PermanentDeletionEffects,
  codecs: { eventCodec: StorageRowCodec<unknown>; receiptCodec: StorageRowCodec<CommandReceipt> },
): Promise<void> {
  const snapshot: PermanentDeletionSnapshot = {
    recordHeads: await tables.heads.toArray(),
    recordRevisions: await tables.revisions.toArray(),
    reverseDependencies: await tables.dependencies.toArray(),
    engineEvaluationAudits: await tables.evaluations.toArray(),
    commandReceipts: await tables.receipts.toArray(),
    domainEvents: await tables.events.toArray(),
  };
  if (!effects.closureUnchanged(snapshot)) throw new DeletionClosureChangedError();

  const purged = new Set<string>(effects.purgedRecordIds);
  const purgedRevisionIds = (snapshot.recordRevisions as Array<{ recordId: string; revisionId: string }>)
    .filter((row) => purged.has(row.recordId))
    .map((row) => row.revisionId);

  // Step 5: prohibited copies and reversible fingerprints.
  for (const redaction of effects.redactedEvents) {
    const existing = await tables.events.get(redaction.eventId);
    if (existing === undefined) throw new DeletionClosureChangedError();
    await tables.events.put(codecs.eventCodec.validateForWrite({ ...(existing as object), payload: redaction.payload }));
  }
  for (const neutralised of effects.neutralisedReceipts) {
    const existing = await tables.receipts.get(neutralised.commandId);
    if (existing === undefined) throw new DeletionClosureChangedError();
    await tables.receipts.put(codecs.receiptCodec.validateForWrite({ ...existing, commandHash: neutralised.commandHash }));
  }
  if (effects.removedEvaluationIds.length > 0) await tables.evaluations.bulkDelete([...effects.removedEvaluationIds]);

  // Step 4: every patient-content revision of every purged record.
  if (purged.size > 0) await tables.revisions.where("recordId").anyOf([...purged]).delete();

  // Step 7: edges made meaningless by the deletion, after their dependents are represented.
  if (purged.size > 0) await tables.dependencies.where("dependentRecordId").anyOf([...purged]).delete();
  if (purgedRevisionIds.length > 0) await tables.dependencies.where("sourceRevisionId").anyOf(purgedRevisionIds).delete();
}
