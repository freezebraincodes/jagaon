import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { installFakeIndexedDb } from "@/application/storage/packet10-test-support";
import { DELETION_PLAN_TTL_MS } from "./deletion-contracts";
import { DELETION_OWNER_ADAPTERS } from "./deletion-owner-registry";
import { createDeletionFixture } from "./packet10-deletion-fixture";

installFakeIndexedDb();
const INTEGRATION_TIMEOUT_MS = 60_000;
const opened: Array<{ name: string; database: { close(): void } }> = [];
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    entry.database.close();
    await Dexie.delete(entry.name);
  }
});
async function fixture() {
  const created = await createDeletionFixture();
  opened.push(created);
  return created;
}

describe("Packet 10A deletion planning (SDEL-001, SDEL-005, SDEL-009)", () => {
  it("registers the enabled owners in the frozen deletion order with no Safety owner", () => {
    expect(DELETION_OWNER_ADAPTERS.map((adapter) => adapter.owner)).toEqual(["HEALTH_RECORDS", "PATTERN_ENGINE", "LEARNING_ENGINE", "INQUIRY", "CARE_PLAN", "CARE_PREPARATION"]);
    expect(DELETION_OWNER_ADAPTERS.some((adapter) => (adapter.recordTypes as readonly string[]).some((type) => type.startsWith("SAFETY_")))).toBe(false);
  });

  it(
    "SDEL-001 binds an exact plan to the target head, dependency closure, hash and 10-minute expiry",
    async () => {
      const h = await fixture();
      const target = await h.targetWithDependent("GLUCOSE_READING", "CARE_SUMMARY_SNAPSHOT");
      const result = await h.service.prepare(target);
      if (result.kind !== "PLAN_READY") throw new Error(result.kind);
      const plan = result.plan;
      expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt)).toBe(DELETION_PLAN_TTL_MS);
      expect(plan.closure.targetHead).toEqual(await h.head(target.recordId));
      const dependentTypes = plan.closure.dependents.map((dependent) => dependent.head.recordType);
      expect(dependentTypes).toContain("CARE_SUMMARY_SNAPSHOT");
      // Owners appear in the frozen order.
      const order = plan.closure.dependents.map((dependent) => DELETION_OWNER_ADAPTERS.findIndex((adapter) => adapter.owner === dependent.owner));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(plan.effects).toEqual({ targetRecordType: "GLUCOSE_READING", dependentCount: plan.closure.dependents.length, externalCopiesNotRecalled: true });
      expect(JSON.stringify(plan.effects)).not.toContain(target.recordId);
      // Same snapshot, same instant: same hash. Different instant: different hash.
      const again = await h.service.prepare(target);
      expect(again.kind === "PLAN_READY" && again.plan.planHash).toBe(plan.planHash);
      h.setClock("2026-10-04T02:01:00.000Z");
      const later = await h.service.prepare(target);
      expect(later.kind === "PLAN_READY" && later.plan.planHash).not.toBe(plan.planHash);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "includes owner companions: pattern observation with its snapshot, inquiry response with its inquiry",
    async () => {
      const h = await fixture();
      const intake = await h.service.prepare(await h.targetWithDependent("INTAKE_EVENT", "PATTERN_EVIDENCE_SNAPSHOT"));
      if (intake.kind !== "PLAN_READY") throw new Error(intake.kind);
      const intakeTypes = intake.plan.closure.dependents.map((dependent) => dependent.head.recordType);
      expect(intakeTypes).toEqual(expect.arrayContaining(["PATTERN_EVIDENCE_SNAPSHOT", "PATTERN_OBSERVATION", "LEARNED_KNOWLEDGE"]));
      const medication = await h.service.prepare(await h.targetWithDependent("MEDICATION_EVENT", "INQUIRY"));
      if (medication.kind !== "PLAN_READY") throw new Error(medication.kind);
      expect(medication.plan.closure.dependents.map((dependent) => dependent.head.recordType).sort()).toEqual(["INQUIRY", "INQUIRY_RESPONSE"]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-005 never adds an independent record related only by time or category",
    async () => {
      const h = await fixture();
      const target = await h.targetWithDependent("GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
      const result = await h.service.prepare(target);
      if (result.kind !== "PLAN_READY") throw new Error(result.kind);
      const purged = new Set<string>(result.plan.closure.purgedRecordIds);
      const sourceTypes = new Set(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT", "MEDICATION", "APPOINTMENT", "CARE_QUESTION", "PRESCRIPTION_VERSION"]);
      const independent = (await h.revisions()).filter((row) => sourceTypes.has(row.recordType) && row.recordId !== target.recordId);
      expect(independent.length).toBeGreaterThan(50);
      expect(independent.some((row) => purged.has(row.recordId))).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-009 refuses system-owned, derived or unknown targets",
    async () => {
      const h = await fixture();
      const heads = (await h.tables()).recordHeads as Array<{ recordId: string; recordType: string }>;
      for (const type of ["REMINDER", "PATTERN_OBSERVATION", "CARE_SUMMARY_SNAPSHOT", "MEDICATION"]) {
        const head = heads.find((entry) => entry.recordType === type)!;
        expect(await h.service.prepare({ recordType: type as never, recordId: head.recordId as never })).toEqual({ kind: "REFUSED", reason: "TARGET_NOT_PATIENT_DELETABLE" });
      }
      expect(await h.service.prepare({ recordType: "GLUCOSE_READING", recordId: "00000000-0000-4000-8000-000000000000" as never })).toEqual({ kind: "REFUSED", reason: "TARGET_NOT_FOUND" });
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
