import { canonicalizeJson, hashCanonicalJson, type Sha256Digest } from "@/application/contracts/canonical-json";
import { frozenClone } from "@/application/deep-freeze";
import { isJournalSourceEventName, JOURNAL_DELETED_EVENT_PAYLOAD } from "@/application/journal/journal-stored-rows";
import type { Instant, RecordHead, RecordId, RecordType } from "@/domain/shared";
import type { PermanentDeletionSnapshot } from "@/storage/permanent-deletion-transaction";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";
import { DELETION_PLAN_TTL_MS, type DeletionClosure, type DeletionPlan, type DeletionPlanRefusal, type DeletionTarget } from "./deletion-contracts";
import { DELETION_OWNER_ADAPTERS, dependentAdapterFor, type StoredRevisionRow } from "./deletion-owner-registry";

/**
 * Exact permanent-deletion planning (storage-backup-spec 6.4; SDEL-001,
 * SDEL-005). The closure contains only records reachable from the target
 * through exact reverse-dependency edges (from any of its revisions) and the
 * owners' inseparable companions, applied to a fixed point. Nearby time,
 * category or context never adds a record.
 */

export class DeletionPlanRefusedError extends Error {
  readonly name = "DeletionPlanRefusedError";
  constructor(readonly reason: DeletionPlanRefusal) {
    super(reason);
  }
}

type Edge = {
  sourceRevisionId: string;
  dependentRecordId: string;
  dependentRecordType: string;
  dependentRevisionId: string;
  dependencyRole: string;
  owner: string;
  evaluatorKey: string;
  evaluatorVersion: string;
};
type Audit = { evaluationId: string; triggeringRevisions: Array<{ revisionId: string }>; consideredRevisions: Array<{ revisionId: string }> };
type Receipt = {
  commandId: string;
  outcome: string;
  resultingRevisions?: Array<{ recordId: string }>;
  existingRevisions?: Array<{ recordId: string }>;
  currentHeads?: Array<{ recordId: string }>;
};
type Event = { eventId: string; eventName: string; change: { recordId: string }; payload: unknown };

function isRedacted(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const keys = Object.keys(payload);
  return keys.length === 1 && (payload as { reasonCode?: unknown }).reasonCode === JOURNAL_DELETED_EVENT_PAYLOAD.reasonCode;
}

const ownerRank = new Map(DELETION_OWNER_ADAPTERS.map((adapter, index) => [adapter.owner, index]));

/** Pure closure computation over one consistent snapshot. */
export function computeDeletionClosure(snapshot: PermanentDeletionSnapshot, target: DeletionTarget): DeletionClosure {
  const heads = new Map((snapshot.recordHeads as RecordHead[]).map((head) => [head.recordId as string, head]));
  const targetHead = heads.get(target.recordId);
  if (!targetHead || targetHead.recordType !== target.recordType) throw new DeletionPlanRefusedError("TARGET_NOT_FOUND");
  if (!(HACKATHON_STORAGE_PROFILE.permanentDeletionTargets as readonly string[]).includes(target.recordType)) throw new DeletionPlanRefusedError("TARGET_NOT_PATIENT_DELETABLE");
  if (targetHead.state !== "ACTIVE") throw new DeletionPlanRefusedError("TARGET_NOT_ACTIVE");

  const revisions = snapshot.recordRevisions as StoredRevisionRow[];
  const revisionsByRecord = new Map<string, string[]>();
  for (const row of revisions) revisionsByRecord.set(row.recordId, [...(revisionsByRecord.get(row.recordId) ?? []), row.revisionId]);
  const edges = snapshot.reverseDependencies as Edge[];

  const purged = new Set<string>([target.recordId]);
  const basis = new Map<string, "EXACT_DEPENDENCY" | "OWNER_COMPANION">();
  const queue: string[] = [target.recordId];
  while (queue.length > 0) {
    const recordId = queue.shift()!;
    const recordType = heads.get(recordId)?.recordType as RecordType | undefined;
    const sourceRevisions = new Set(revisionsByRecord.get(recordId) ?? []);
    const reached = edges.filter((edge) => sourceRevisions.has(edge.sourceRevisionId)).map((edge) => edge.dependentRecordId);
    const adapter = recordType ? (recordId === target.recordId ? null : dependentAdapterFor(recordType)) : null;
    const companions = adapter && recordType ? adapter.companions(recordId, recordType, revisions) : [];
    for (const [next, why] of [...reached.map((id) => [id, "EXACT_DEPENDENCY"] as const), ...companions.map((id) => [id, "OWNER_COMPANION"] as const)]) {
      if (purged.has(next)) continue;
      purged.add(next);
      basis.set(next, why);
      queue.push(next);
    }
  }

  const dependents = [...purged]
    .filter((recordId) => recordId !== target.recordId)
    .map((recordId) => {
      const head = heads.get(recordId);
      if (!head) throw new DeletionPlanRefusedError("DEPENDENT_NOT_ACTIVE");
      const adapter = dependentAdapterFor(head.recordType);
      if (!adapter) throw new DeletionPlanRefusedError("UNSUPPORTED_DEPENDENT");
      if (head.state !== "ACTIVE") throw new DeletionPlanRefusedError("DEPENDENT_NOT_ACTIVE");
      return { owner: adapter.owner, head };
    })
    .sort((a, b) => ownerRank.get(a.owner)! - ownerRank.get(b.owner)! || (a.head.recordId < b.head.recordId ? -1 : a.head.recordId > b.head.recordId ? 1 : 0));

  const purgedRevisionIds = new Set(revisions.filter((row) => purged.has(row.recordId)).map((row) => row.revisionId));
  const evaluationIds = (snapshot.engineEvaluationAudits as Audit[])
    .filter((audit) => [...audit.triggeringRevisions, ...audit.consideredRevisions].some((ref) => purgedRevisionIds.has(ref.revisionId)))
    .map((audit) => audit.evaluationId)
    .sort();
  const receiptCommandIds = (snapshot.commandReceipts as Receipt[])
    .filter((receipt) => [...(receipt.resultingRevisions ?? []), ...(receipt.existingRevisions ?? []), ...(receipt.currentHeads ?? [])].some((ref) => purged.has(ref.recordId)))
    .map((receipt) => receipt.commandId)
    .sort();
  const redactedEventIds = (snapshot.domainEvents as Event[])
    .filter((event) => purged.has(event.change.recordId) && isJournalSourceEventName(event.eventName) && !isRedacted(event.payload))
    .map((event) => event.eventId)
    .sort();

  const edgeKey = (edge: Edge) => `${edge.sourceRevisionId}|${edge.dependentRevisionId}|${edge.dependencyRole}`;
  const closureEdges = edges
    .filter((edge) => purgedRevisionIds.has(edge.sourceRevisionId) || purged.has(edge.dependentRecordId))
    .sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0))
    .map((edge) => ({
      sourceRevisionId: edge.sourceRevisionId,
      dependentRecordId: edge.dependentRecordId,
      dependentRevisionId: edge.dependentRevisionId,
      dependencyRole: edge.dependencyRole,
      owner: edge.owner,
      evaluatorKey: edge.evaluatorKey,
      evaluatorVersion: edge.evaluatorVersion,
    }));
  const consequences = dependents.map((dependent) => ({
    owner: dependent.owner,
    recordType: dependent.head.recordType,
    recordId: dependent.head.recordId,
    outcome: "PERMANENTLY_WITHDRAWN" as const,
    basis: basis.get(dependent.head.recordId) ?? "EXACT_DEPENDENCY",
  }));

  return {
    targetHead,
    dependents,
    edges: closureEdges,
    consequences,
    purgedRecordIds: [target.recordId, ...dependents.map((dependent) => dependent.head.recordId)] as RecordId[],
    evaluationIds,
    receiptCommandIds,
    redactedEventIds,
  };
}

/** Canonical identity of the complete closure: heads, edges, consequences and every removed artefact. */
export function closureFingerprint(closure: DeletionClosure): string {
  return canonicalizeJson({
    target: closure.targetHead,
    dependents: closure.dependents,
    edges: closure.edges,
    consequences: closure.consequences,
    purged: closure.purgedRecordIds,
    evaluations: closure.evaluationIds,
    receipts: closure.receiptCommandIds,
    events: closure.redactedEventIds,
  });
}

/** Every field that a confirmation commits, exactly as reviewed. */
export function deletionPlanMaterial(plan: Omit<DeletionPlan, "planHash">): unknown {
  return {
    profile: "JAGAON_DELETION_PLAN_V2",
    target: plan.target,
    closure: plan.closure,
    closureFingerprint: plan.closureFingerprint,
    neutralisedReceipts: plan.neutralisedReceipts,
    effects: plan.effects,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  };
}

export function deletionPlanHash(material: unknown): Promise<Sha256Digest> {
  return hashCanonicalJson(material);
}

/** A content-free replacement for a receipt hash that could fingerprint deleted content. */
export function neutralisedCommandHash(commandId: string): Promise<Sha256Digest> {
  return hashCanonicalJson({ profile: "JAGAON_DELETED_COMMAND_HASH_V1", commandId });
}

export async function buildDeletionPlan(snapshot: PermanentDeletionSnapshot, target: DeletionTarget, now: Instant): Promise<DeletionPlan> {
  const closure = computeDeletionClosure(snapshot, target);
  const fingerprint = closureFingerprint(closure);
  const expiresAt = new Date(Date.parse(now) + DELETION_PLAN_TTL_MS).toISOString() as Instant;
  const neutralisedReceipts = await neutralisedReceiptsFor(closure);
  const material = {
    createdAt: now,
    expiresAt,
    target: { recordType: target.recordType, recordId: target.recordId },
    closure,
    closureFingerprint: fingerprint,
    neutralisedReceipts,
    effects: { targetRecordType: target.recordType, dependentCount: closure.dependents.length, externalCopiesNotRecalled: true as const },
  };
  const planHash = await deletionPlanHash(deletionPlanMaterial(material));
  // The caller receives a deep, frozen copy that shares nothing with internal state.
  return frozenClone({ planHash, ...material });
}

export async function neutralisedReceiptsFor(closure: DeletionClosure): Promise<Array<{ commandId: string; commandHash: Sha256Digest }>> {
  return Promise.all(closure.receiptCommandIds.map(async (commandId) => ({ commandId, commandHash: await neutralisedCommandHash(commandId) })));
}
