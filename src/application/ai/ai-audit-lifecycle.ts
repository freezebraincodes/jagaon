import { AI_AUDIT_DOWNSTREAM_RECORD_TYPES, aiInvocationAuditRowSchema, type AiInvocationAuditRow } from "@/domain/ai/ai-invocation-audit";

/**
 * AI invocation audits in the Packet 10 lifecycle (storage-backup-spec 6.6,
 * 6.7, 8.4–8.7; Packet 11A owner decision, blocker 1 option b). One closed set
 * of pure rules is shared by the deletion planner, the same-lineage restore
 * overlay, backup inspection, restore target verification and post-restore
 * reconciliation, so every path agrees on which audit names which record.
 * Results carry only a closed reason; no row or value leaves.
 */

/** The only payload keys that hold an AI audit reference (domain-schema-spec 11.7 and Inquiry). */
export const AI_AUDIT_REFERENCE_KEYS = Object.freeze(["aiInvocation", "aiInvocationAuditRef"] as const);

/** Every AI audit reference at any depth of a canonical revision payload, in document order. */
export function aiAuditReferencesIn(payload: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((AI_AUDIT_REFERENCE_KEYS as readonly string[]).includes(key)) found.push(child);
      else walk(child);
    }
  };
  walk(payload);
  return found;
}

type LocalRef = { recordId?: unknown; revisionId?: unknown };
type LooseAudit = { requestId?: unknown; sourceRevisions?: unknown; downstream?: unknown };

/**
 * Audits whose exact local source or downstream reference would retain or
 * reveal a purged relationship (spec 6.6). They are removed with the deletion;
 * an audit that never named a patient record is unaffected.
 */
export function aiAuditsAffectedByDeletion(audits: readonly unknown[], purged: { recordIds: ReadonlySet<string>; revisionIds: ReadonlySet<string> }): string[] {
  const touches = (ref: LocalRef) => purged.recordIds.has(ref.recordId as string) || purged.revisionIds.has(ref.revisionId as string);
  return (audits as LooseAudit[])
    .filter((audit) => {
      const refs = [...(Array.isArray(audit.sourceRevisions) ? (audit.sourceRevisions as LocalRef[]) : []), ...(audit.downstream ? [audit.downstream as LocalRef] : [])];
      return refs.some(touches);
    })
    .map((audit) => audit.requestId as string)
    .sort();
}

export type AiAuditReferenceValidation = { kind: "VALID" } | { kind: "INVALID"; reason: "MALFORMED" | "DUPLICATE" | "DANGLING" | "MISMATCH" | "UNKNOWN" };

type RevisionRow = { recordType: string; recordId: string; revisionId: string; revision?: { payload?: unknown } };

const OWNING_TASK: ReadonlyMap<string, string> = new Map(Object.entries(AI_AUDIT_DOWNSTREAM_RECORD_TYPES).map(([task, recordType]) => [recordType, task]));

/**
 * Exact closure between canonical revisions and AI audits (spec 8.4–8.7):
 * every audit row is the exact closed row; every source and downstream it
 * names resolves to that same record and revision; every payload reference
 * resolves to an accepted audit of the task that owns that record type and,
 * when the audit names a downstream record, to that record; a downstream
 * record references its audit back.
 */
export function validateAiAuditReferences(tables: { recordRevisions: readonly unknown[]; aiInvocationAudits: readonly unknown[] }): AiAuditReferenceValidation {
  const invalid = (reason: Exclude<AiAuditReferenceValidation, { kind: "VALID" }>["reason"]): AiAuditReferenceValidation => ({ kind: "INVALID", reason });
  const audits = new Map<string, AiInvocationAuditRow>();
  for (const value of tables.aiInvocationAudits) {
    const parsed = aiInvocationAuditRowSchema.safeParse(value);
    if (!parsed.success) return invalid("MALFORMED");
    if (audits.has(parsed.data.requestId)) return invalid("DUPLICATE");
    audits.set(parsed.data.requestId, parsed.data);
  }
  const revisions = tables.recordRevisions as RevisionRow[];
  const byRevision = new Map(revisions.map((row) => [row.revisionId, row]));

  // Canonical payloads: each reference resolves to an accepted audit of the owning task.
  const referencedBy = new Map<string, Set<string>>();
  for (const row of revisions) {
    for (const ref of aiAuditReferencesIn(row.revision?.payload)) {
      if (typeof ref !== "string") return invalid("MALFORMED");
      const task = OWNING_TASK.get(row.recordType);
      if (!task) return invalid("UNKNOWN");
      const audit = audits.get(ref);
      if (!audit) return invalid("DANGLING");
      if (audit.outcomeCode !== "ACCEPTED" || audit.taskType !== task) return invalid("MISMATCH");
      if (audit.downstream && (audit.downstream.recordId !== row.recordId || audit.downstream.recordType !== row.recordType)) return invalid("MISMATCH");
      referencedBy.set(ref, (referencedBy.get(ref) ?? new Set()).add(row.recordId));
    }
  }

  // Audit rows: every named source and downstream resolves exactly; a downstream references back.
  for (const audit of audits.values()) {
    for (const ref of [...audit.sourceRevisions, ...(audit.downstream ? [audit.downstream] : [])]) {
      const row = byRevision.get(ref.revisionId);
      if (!row) return invalid("DANGLING");
      if (row.recordType !== ref.recordType || row.recordId !== ref.recordId) return invalid("MISMATCH");
    }
    if (audit.downstream && !referencedBy.get(audit.requestId)?.has(audit.downstream.recordId)) return invalid("MISMATCH");
  }
  return { kind: "VALID" };
}
