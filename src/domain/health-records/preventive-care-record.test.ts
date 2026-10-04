import { describe, expect, it } from "vitest";
import { preventiveCareRecordPayloadSchema, preventiveCareRecordRevisionSchema } from "./preventive-care-record";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-10-02T13:00:00.000Z";
const PATIENT = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };
const SYSTEM = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) => (result.success ? [] : result.error!.issues.map((issue) => issue.message));

const record = (overrides: Record<string, unknown> = {}) => ({
  careReference: { kind: "PLANNED_ITEM", item: { recordType: "PREVENTIVE_CARE_ITEM", recordId: ID(1), revisionId: ID(2) } },
  completionReport: { kind: "PATIENT_REPORTED_COMPLETED" },
  ...overrides,
});
const revision = (payload: unknown, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  recordType: "PREVENTIVE_CARE_RECORD",
  recordId: ID(10),
  revisionId: ID(11),
  revisionNumber: 1,
  previousRevisionId: null,
  action: "CREATE",
  recordedAt: T0,
  revisionCreatedAt: T0,
  temporal: { kind: "POINT", occurrence: { kind: "DATE_ONLY", localDate: "2026-09-14", timeZoneId: "Asia/Singapore" } },
  provenance: PATIENT,
  auditEventId: ID(12),
  transactionId: ID(13),
  payload,
  ...overrides,
});

describe("PREVENTIVE_CARE_RECORD contract (domain 7.3)", () => {
  it("records a planned or unplanned occurrence and the patient's completion report", () => {
    expect(preventiveCareRecordPayloadSchema.safeParse(record()).success).toBe(true);
    expect(preventiveCareRecordPayloadSchema.safeParse(record({ careReference: { kind: "UNPLANNED", identity: { kind: "PATIENT_DEFINED", label: "Dental clean" } } })).success).toBe(true);
    expect(preventiveCareRecordPayloadSchema.safeParse(record({ completionReport: { kind: "PATIENT_UNSURE" } })).success).toBe(true);
    expect(preventiveCareRecordPayloadSchema.safeParse(record({ careReference: { kind: "PLANNED_ITEM", item: { recordType: "APPOINTMENT", recordId: ID(1), revisionId: ID(2) } } })).success).toBe(false);
  });

  it("stores no clinical result, verification, follow-up or next interval", () => {
    for (const extra of [{ result: "NORMAL" }, { verified: true }, { followUpRequired: false }, { nextInterval: "1y" }, { completionReport: { kind: "NOT_COMPLETED" } }]) {
      expect(preventiveCareRecordPayloadSchema.safeParse(record(extra)).success).toBe(false);
    }
  });

  it("keeps an unknown occurrence time unknown and needs POINT meaning", () => {
    expect(preventiveCareRecordRevisionSchema.safeParse(revision(record(), { temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } } })).success).toBe(true);
    expect(preventiveCareRecordRevisionSchema.safeParse(revision(record(), { temporal: { kind: "ATEMPORAL" } })).success).toBe(false);
  });

  it("allows only patient CREATE and CORRECT", () => {
    expect(preventiveCareRecordRevisionSchema.safeParse(revision(record())).success).toBe(true);
    expect(issues(preventiveCareRecordRevisionSchema.safeParse(revision(record(), { provenance: SYSTEM })))).toContain("PREVENTIVE_RECORD_REQUIRES_PATIENT");
    expect(issues(preventiveCareRecordRevisionSchema.safeParse(revision(record(), { action: "SUPERSEDE" })))).toContain("UNSUPPORTED_REVISION_ACTION");
  });
});
