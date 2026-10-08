import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { createAiInvocationAuditRepository } from "@/application/ai/ai-audit-persistence";
import { installFakeIndexedDb, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { aiInvocationAuditRowSchema, type AiInvocationAuditRow } from "@/domain/ai";
import { deterministicAuditRowFixture, explainAuditRowFixture } from "@/domain/ai/ai-test-fixtures";
import type { PermanentDeletionSnapshot } from "@/storage/permanent-deletion-transaction";
import { computeDeletionClosure, DeletionPlanRefusedError } from "./deletion-planner";
import { createDeletionFixture } from "./packet10-deletion-fixture";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import { projectValidatedAiCareSummary } from "@/application/care-preparation/ai-care-summary-replacement";
import { createCarePreparationQuery } from "@/application/care-preparation/care-preparation-query";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { acceptedAiCareComposition } from "@/application/care-preparation/care-preparation-test-support";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";

/**
 * Packet 11A Task 5 (owner decision, blocker 1 option b): permanent deletion
 * reconciles AI invocation audits in the same plan and transaction
 * (storage-backup-spec 6.6). An audit whose local source or downstream
 * reference would retain the deleted relationship is removed with it.
 */

installFakeIndexedDb();
const TIMEOUT = 120_000;
const opened: Array<{ name: string; database: { close(): void } }> = [];
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    entry.database.close();
    await Dexie.delete(entry.name);
  }
});

const AFFECTED = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SURVIVOR = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const LATE = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
const DETERMINISTIC = deterministicAuditRowFixture().requestId;

type Revision = { recordId: string; recordType: string; revisionId: string };

async function setup() {
  const h = await createDeletionFixture();
  opened.push(h);
  const target = await h.targetWithDependent("GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
  const prepared = await h.service.prepare(target);
  if (prepared.kind !== "PLAN_READY") throw new Error(prepared.kind);
  const purged = new Set<string>(prepared.plan.closure.purgedRecordIds);
  const revisions = (await h.revisions()) as Revision[];
  const targetRevision = revisions.find((row) => row.recordId === target.recordId)!;
  const survivorRevision = revisions.find((row) => row.recordType === "GLUCOSE_READING" && !purged.has(row.recordId))!;
  const audits = createAiInvocationAuditRepository(h.database);
  await audits.append(aiInvocationAuditRowSchema.parse(explainAuditRowFixture(AFFECTED, [targetRevision])));
  await audits.append(aiInvocationAuditRowSchema.parse(explainAuditRowFixture(SURVIVOR, [survivorRevision])));
  await audits.append(aiInvocationAuditRowSchema.parse(deterministicAuditRowFixture()));
  const plan = await h.service.prepare(target);
  if (plan.kind !== "PLAN_READY") throw new Error(plan.kind);
  return { h, target, plan: plan.plan, targetRevision, audits };
}

const auditIds = async (h: { database: Dexie }) => ((await h.database.table("aiInvocationAudits").toArray()) as AiInvocationAuditRow[]).map((row) => row.requestId).sort();

describe("permanent deletion and AI invocation audits", () => {
  it(
    "the plan's exact closure names every affected audit and the commit removes only those",
    async () => {
      const { h, plan } = await setup();
      expect(plan.closure.aiInvocationRequestIds).toEqual([AFFECTED]);
      expect((await h.service.confirm(plan, { planHash: plan.planHash, confirmedAt: PACKET10_NOW })).kind).toBe("DELETED");
      expect(await auditIds(h)).toEqual([DETERMINISTIC, SURVIVOR].sort());
      // No retained audit names any purged record or revision.
      const tables = await h.tables();
      const purged = new Set<string>(plan.closure.purgedRecordIds);
      for (const row of tables.aiInvocationAudits as AiInvocationAuditRow[]) {
        for (const ref of [...row.sourceRevisions, ...(row.downstream ? [row.downstream] : [])]) expect(purged.has(ref.recordId)).toBe(false);
      }
      expect(JSON.stringify(tables.aiInvocationAudits)).not.toContain(AFFECTED);
    },
    TIMEOUT,
  );

  it(
    "a new audit naming the target after planning makes confirmation stale and changes nothing",
    async () => {
      const { h, plan, targetRevision, audits } = await setup();
      await audits.append(aiInvocationAuditRowSchema.parse(explainAuditRowFixture(LATE, [targetRevision])));
      const before = await h.tables();
      expect((await h.service.confirm(plan, { planHash: plan.planHash, confirmedAt: PACKET10_NOW })).kind).toBe("STALE");
      expect(await h.tables()).toEqual(before);
    },
    TIMEOUT,
  );

  it.each([
    ["aiInvocationAudits", "deleting"],
    ["recordRevisions", "deleting"],
    ["recordHeads", "updating"],
  ] as const)(
    "an injected failure while %s is %s rolls the audit removal back with everything else",
    async (table, hook) => {
      const { h, plan } = await setup();
      const before = await h.tables();
      const fail = () => {
        throw new Error("injected");
      };
      const dexieTable = h.database.table(table);
      (dexieTable.hook as (name: string, fn: () => void) => void)(hook, fail);
      try {
        expect(await h.service.confirm(plan, { planHash: plan.planHash, confirmedAt: PACKET10_NOW })).toMatchObject({ kind: "FAILED" });
      } finally {
        (dexieTable.hook as unknown as (name: string) => { unsubscribe(fn: () => void): void })(hook).unsubscribe(fail);
      }
      expect(await h.tables()).toEqual(before);
      expect(await auditIds(h)).toContain(AFFECTED);
    },
    TIMEOUT,
  );

  it(
    "refuses a plan that would leave a surviving record pointing at a removed audit (no orphaned care-summary reference)",
    async () => {
      const { h, target } = await setup();
      const tables = await h.tables();
      // A surviving care-summary snapshot (outside the closure) whose composition names the audit the deletion must remove.
      const existing = (tables.recordRevisions as Array<Revision & { revision: { payload: Record<string, unknown> } }>).find((row) => row.recordType === "CARE_SUMMARY_SNAPSHOT")!;
      const survivor = {
        ...existing,
        recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4c01",
        revisionId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4c02",
        revision: { ...existing.revision, payload: { ...existing.revision.payload, composition: { method: "AI_ASSISTED", templateVersion: "t", aiInvocationAuditRef: AFFECTED, validatedAt: PACKET10_NOW } } },
      };
      const snapshot = { ...(tables as unknown as PermanentDeletionSnapshot), recordRevisions: [...tables.recordRevisions, survivor] };
      expect(() => computeDeletionClosure(snapshot, target)).toThrow(DeletionPlanRefusedError);
      // Without that reference the same snapshot plans normally.
      expect(computeDeletionClosure(tables as unknown as PermanentDeletionSnapshot, target).aiInvocationRequestIds).toEqual([AFFECTED]);
    },
    TIMEOUT,
  );

  it(
    "Packet 11C B1b: deleting a source of a real AI-assisted snapshot purges that snapshot, the preview it superseded and its AI audit together",
    async () => {
      const h = await createDeletionFixture();
      opened.push(h);
      const uuid = () => crypto.randomUUID() as never;
      const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid };
      const carePreparation = createCarePreparationService(h.database, { now: () => PACKET10_NOW, ids, projectAiCareSummary: projectValidatedAiCareSummary });
      const visit = await createCareOrganisationQuery(h.database, { now: () => PACKET10_NOW }).loadVisitPreparation();
      if (visit.status !== "READY" || !visit.appointment) throw new Error("visit");
      const readings = visit.factGroups.find((group) => group.key === "GLUCOSE")!.sources.slice(0, 3);
      const prepared = await carePreparation.prepare({ locale: "en-SG", period: visit.period, appointment: null, groups: [{ key: "GLUCOSE", sources: readings }], questions: [], notSelected: [] });
      if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
      const loaded = await createCarePreparationQuery(h.database).loadSummary(prepared.recordId);
      if (loaded.status !== "READY") throw new Error("ready");
      const ai = await acceptedAiCareComposition(loaded.payload, { candidate: shellCandidate, requestId: crypto.randomUUID(), audit: createAiInvocationAuditRepository(h.database) });
      const replaced = await carePreparation.replaceWithAiAssistedPreview({ recordId: prepared.recordId, expectedRevisionId: prepared.revisionId, expectedRevisionNumber: 1, expectedContentHash: loaded.payload.rendering.contentHash, composition: ai.composition, aiInvocationAuditRef: ai.auditRef, validatedAt: PACKET10_NOW });
      if (replaced.kind !== "COMMITTED") throw new Error(JSON.stringify(replaced));

      const target = { recordType: "GLUCOSE_READING" as const, recordId: readings[0]!.recordId };
      const plan = await h.service.prepare(target);
      if (plan.kind !== "PLAN_READY") throw new Error(plan.kind);
      expect(plan.plan.closure.purgedRecordIds).toEqual(expect.arrayContaining([target.recordId, prepared.recordId, replaced.recordId]));
      expect(plan.plan.closure.aiInvocationRequestIds).toContain(ai.auditRef);
      expect((await h.service.confirm(plan.plan, { planHash: plan.plan.planHash, confirmedAt: PACKET10_NOW })).kind).toBe("DELETED");
      expect(await auditIds(h)).not.toContain(ai.auditRef);
      const left = (await h.revisions()).filter((row) => row.recordId === replaced.recordId || row.recordId === prepared.recordId);
      expect(left).toEqual([]);
      expect((await h.head(replaced.recordId))?.state).toBe("DELETED");
    },
    TIMEOUT,
  );
});
