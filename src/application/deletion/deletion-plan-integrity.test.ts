import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { installFakeIndexedDb, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import type { DeletionPlan } from "./deletion-contracts";
import { deletionPlanHash, deletionPlanMaterial } from "./deletion-planner";
import { createDeletionFixture } from "./packet10-deletion-fixture";

/** Corrective Pass A item 1: a returned plan is immutable and binds every destructive effect. */

installFakeIndexedDb();
const TIMEOUT = 120_000;
const opened: Array<{ name: string; database: { close(): void } }> = [];
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    entry.database.close();
    await Dexie.delete(entry.name);
  }
});

async function setup() {
  const h = await createDeletionFixture();
  opened.push(h);
  const target = await h.targetWithDependent("GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
  const prepared = await h.service.prepare(target);
  if (prepared.kind !== "PLAN_READY") throw new Error(prepared.kind);
  const independent = (await h.revisions()).find((row) => row.recordType === "GLUCOSE_READING" && !prepared.plan.closure.purgedRecordIds.includes(row.recordId as never))!;
  return { h, plan: prepared.plan, independent };
}

const confirmation = (plan: DeletionPlan) => ({ planHash: plan.planHash, confirmedAt: PACKET10_NOW });

function forge(plan: DeletionPlan, change: (material: Record<string, any>) => void): DeletionPlan {
  const copy = structuredClone(plan) as any;
  change(copy);
  return copy as DeletionPlan;
}

describe("deletion-plan immutability and confirmation binding", () => {
  it(
    "returns a deeply frozen plan that cannot be mutated through `as any`",
    async () => {
      const { plan, independent } = await setup();
      const anyPlan = plan as any;
      for (const value of [plan, plan.target, plan.closure, plan.closure.targetHead, plan.closure.dependents, plan.closure.dependents[0], plan.closure.dependents[0]!.head, plan.closure.purgedRecordIds, plan.closure.evaluationIds, plan.closure.receiptCommandIds, plan.closure.redactedEventIds, plan.neutralisedReceipts, plan.effects]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      expect(() => anyPlan.closure.purgedRecordIds.push(independent.recordId)).toThrow(TypeError);
      expect(() => (anyPlan.closure.dependents[0].head.headRevisionId = "x")).toThrow(TypeError);
      expect(() => (anyPlan.target.recordId = independent.recordId)).toThrow(TypeError);
      expect(() => anyPlan.neutralisedReceipts.pop()).toThrow(TypeError);
    },
    TIMEOUT,
  );

  it(
    "rejects a forged plan that keeps the reviewed hash but changes any destructive material",
    async () => {
      const { h, plan, independent } = await setup();
      const before = await h.tables();
      const forgeries = [
        forge(plan, (copy) => copy.closure.purgedRecordIds.push(independent.recordId)),
        forge(plan, (copy) => copy.closure.dependents.pop()),
        forge(plan, (copy) => (copy.target.recordId = independent.recordId)),
        forge(plan, (copy) => copy.closure.evaluationIds.push("0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f")),
        forge(plan, (copy) => copy.closure.redactedEventIds.splice(0, 1)),
        forge(plan, (copy) => (copy.neutralisedReceipts[0].commandHash = "0".repeat(64))),
        forge(plan, (copy) => (copy.expiresAt = "2027-01-01T00:00:00.000Z")),
      ];
      for (const forged of forgeries) {
        expect((await h.service.confirm(forged, confirmation(forged))).kind).toBe("STALE");
      }
      expect(await h.tables()).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "rejects a forged plan whose hash was recomputed over changed material, deleting nothing extra",
    async () => {
      const { h, plan, independent } = await setup();
      const before = await h.tables();
      for (const change of [
        (copy: Record<string, any>) => copy.closure.purgedRecordIds.push(independent.recordId),
        (copy: Record<string, any>) => copy.closure.dependents.pop(),
      ]) {
        const forged = forge(plan, change) as any;
        forged.planHash = await deletionPlanHash(deletionPlanMaterial(forged));
        expect((await h.service.confirm(forged, confirmation(forged))).kind).toBe("STALE");
      }
      expect(await h.tables()).toEqual(before);
      // The genuine plan still deletes exactly its own closure.
      expect((await h.service.confirm(plan, confirmation(plan))).kind).toBe("DELETED");
      const after = await h.tables();
      expect((after.recordHeads as Array<{ recordId: string; state: string }>).find((row) => row.recordId === independent.recordId)?.state).toBe("ACTIVE");
      expect((after.deletionTombstones as Array<{ recordId: string }>).map((row) => row.recordId).sort()).toEqual([...plan.closure.purgedRecordIds].sort());
    },
    TIMEOUT,
  );

  it(
    "binds the exact dependency-edge identity: a changed edge role makes the plan stale",
    async () => {
      const { h, plan } = await setup();
      const targetRevisions = new Set((await h.revisions()).filter((row) => row.recordId === plan.target.recordId).map((row) => row.revisionId));
      const edge = (await h.edges()).find((row) => targetRevisions.has(row.sourceRevisionId))! as unknown as Record<string, unknown>;
      await h.database.table("reverseDependencies").delete([edge.sourceRevisionId, edge.dependentRevisionId, edge.dependencyRole] as never);
      await h.database.table("reverseDependencies").add({ ...edge, dependencyRole: edge.dependencyRole === "SUPPORTING_EVIDENCE" ? "CONTRADICTORY_EVIDENCE" : "SUPPORTING_EVIDENCE" } as never);
      const before = await h.tables();
      expect((await h.service.confirm(plan, confirmation(plan))).kind).toBe("STALE");
      expect(await h.tables()).toEqual(before);
    },
    TIMEOUT,
  );
});
