import { describe, expect, it } from "vitest";
import { PREVENTIVE_CARE_CATALOGUE, preventiveCareItemPayloadSchema, preventiveCareItemRevisionSchema } from "./preventive-care";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-10-02T13:00:00.000Z";
const PATIENT = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };
const SYSTEM = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) => (result.success ? [] : result.error!.issues.map((issue) => issue.message));

const item = (overrides: Record<string, unknown> = {}) => ({
  identity: { kind: "REVIEWED_CATALOGUE_MATCH", catalogueEntryKey: "EYE_SCREENING", catalogueVersion: "preventive-care-catalogue.1", label: "Eye screening" },
  trackingState: "ACTIVE",
  schedule: { kind: "TARGET_DATE", targetDate: "2026-11-03" },
  ...overrides,
});
const revision = (payload: unknown, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  recordType: "PREVENTIVE_CARE_ITEM",
  recordId: ID(10),
  revisionId: ID(11),
  revisionNumber: 1,
  previousRevisionId: null,
  action: "CREATE",
  recordedAt: T0,
  revisionCreatedAt: T0,
  temporal: { kind: "ATEMPORAL" },
  provenance: PATIENT,
  auditEventId: ID(12),
  transactionId: ID(13),
  payload,
  ...overrides,
});

describe("PREVENTIVE_CARE_ITEM contract (domain 7.2)", () => {
  it("accepts a reviewed catalogue match only for a known key, version and reviewed label", () => {
    expect(preventiveCareItemPayloadSchema.safeParse(item()).success).toBe(true);
    expect(preventiveCareItemPayloadSchema.safeParse(item({ identity: { ...item().identity, label: "眼睛检查" } })).success).toBe(true);
    expect(issues(preventiveCareItemPayloadSchema.safeParse(item({ identity: { ...item().identity, catalogueEntryKey: "COLONOSCOPY" } })))).toContain("UNKNOWN_CATALOGUE_ENTRY");
    expect(issues(preventiveCareItemPayloadSchema.safeParse(item({ identity: { ...item().identity, label: "Eye exam" } })))).toContain("LABEL_NOT_REVIEWED_FOR_ENTRY");
    expect(PREVENTIVE_CARE_CATALOGUE.version).toBe("preventive-care-catalogue.1");
  });

  it("keeps a patient-defined item usable without catalogue or AI matching", () => {
    expect(preventiveCareItemPayloadSchema.safeParse(item({ identity: { kind: "PATIENT_DEFINED", label: "Dental clean" } })).success).toBe(true);
    expect(preventiveCareItemPayloadSchema.safeParse(item({ identity: { kind: "PATIENT_DEFINED", label: "   " } })).success).toBe(false);
  });

  it("validates schedule forms with real calendar dates and positive whole intervals", () => {
    const schedule = (value: unknown) => preventiveCareItemPayloadSchema.safeParse(item({ schedule: value })).success;
    expect(schedule({ kind: "UNSCHEDULED" })).toBe(true);
    expect(schedule({ kind: "TARGET_DATE", targetDate: "2026-02-30" })).toBe(false);
    expect(schedule({ kind: "RECURRING_REPORTED_PLAN", intervalCount: 1, intervalUnit: "YEAR" })).toBe(true);
    expect(schedule({ kind: "RECURRING_REPORTED_PLAN", intervalCount: 1, intervalUnit: "YEAR", nextTargetDate: "2027-01-05" })).toBe(true);
    expect(schedule({ kind: "RECURRING_REPORTED_PLAN", intervalCount: 0, intervalUnit: "YEAR" })).toBe(false);
    expect(schedule({ kind: "RECURRING_REPORTED_PLAN", intervalCount: 1.5, intervalUnit: "MONTH" })).toBe(false);
  });

  it("rejects any inferred due, overdue, eligibility or completion field", () => {
    for (const extra of [{ dueDate: "2026-11-03" }, { overdue: true }, { eligible: true }, { completed: true }, { recommendedInterval: "1y" }]) {
      expect(preventiveCareItemPayloadSchema.safeParse(item(extra)).success).toBe(false);
    }
    for (const state of ["ACTIVE", "PAUSED", "ENDED"]) expect(preventiveCareItemPayloadSchema.safeParse(item({ trackingState: state })).success).toBe(true);
    expect(preventiveCareItemPayloadSchema.safeParse(item({ trackingState: "OVERDUE" })).success).toBe(false);
  });

  it("allows only patient-initiated CREATE, CORRECT and SUPERSEDE revisions", () => {
    expect(preventiveCareItemRevisionSchema.safeParse(revision(item())).success).toBe(true);
    expect(issues(preventiveCareItemRevisionSchema.safeParse(revision(item(), { provenance: SYSTEM })))).toContain("PREVENTIVE_ITEM_CHANGE_REQUIRES_PATIENT");
    expect(issues(preventiveCareItemRevisionSchema.safeParse(revision(item(), { action: "SYSTEM_DERIVE" })))).toContain("UNSUPPORTED_REVISION_ACTION");
    expect(preventiveCareItemRevisionSchema.safeParse(revision(item(), { temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } } })).success).toBe(false);
  });
});
