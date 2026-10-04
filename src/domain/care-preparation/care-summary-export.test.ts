import { describe, expect, it } from "vitest";
import { HACKATHON_EXPORT_PROFILE, careSummaryExportPayloadSchema, careSummaryExportRevisionSchema } from "./care-summary-export";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HASH = "c".repeat(64);
const AT = "2026-10-04T02:00:00.000Z";
const LATER = "2026-10-04T02:00:05.000Z";

const payload = (overrides: Record<string, unknown> = {}) => ({
  snapshot: { recordType: "CARE_SUMMARY_SNAPSHOT", recordId: id(1), revisionId: id(2) },
  approvedContentHash: HASH,
  method: "PRINT_DIALOG",
  artifactFormat: "PRINTABLE_DOCUMENT",
  requestedAt: AT,
  outcome: { state: "REQUESTED" },
  externalConfirmation: { state: "NONE" },
  replacesExports: [],
  ...overrides,
});
const issuesOf = (value: unknown) => {
  const result = careSummaryExportPayloadSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("care-summary export payload", () => {
  it("is print-dialog and printable-document only in the hackathon profile", () => {
    expect(HACKATHON_EXPORT_PROFILE).toEqual({ method: "PRINT_DIALOG", artifactFormat: "PRINTABLE_DOCUMENT" });
    expect(issuesOf(payload())).toEqual([]);
    expect(issuesOf(payload({ method: "FILE_DOWNLOAD", artifactFormat: "PDF" }))).toContain("EXPORT_METHOD_NOT_ENABLED");
    expect(issuesOf(payload({ method: "OS_SHARE_SHEET" }))).toContain("EXPORT_METHOD_NOT_ENABLED");
  });

  it("records only print outcomes the browser can evidence", () => {
    expect(issuesOf(payload({ outcome: { state: "EXPORTED", completedAt: LATER, artifactHash: HASH, byteLength: 120, evidence: "PRINT_DIALOG_OPENED" } }))).toEqual([]);
    expect(issuesOf(payload({ outcome: { state: "EXPORTED", completedAt: LATER, artifactHash: HASH, evidence: "OS_SHARE_SHEET_OPENED" } }))).toContain("EXPORT_OUTCOME_INVALID");
    expect(issuesOf(payload({ outcome: { state: "FAILED", failedAt: LATER, reason: "PRINT_UNAVAILABLE" } }))).toEqual([]);
    expect(issuesOf(payload({ outcome: { state: "FAILED", failedAt: LATER, reason: "SHARE_API_UNAVAILABLE" } }))).toContain("EXPORT_OUTCOME_INVALID");
    expect(issuesOf(payload({ outcome: { state: "OUTCOME_UNKNOWN", lastObservedAt: LATER, stage: "PRINT" } }))).toEqual([]);
    expect(issuesOf(payload({ outcome: { state: "OUTCOME_UNKNOWN", lastObservedAt: "2026-10-04T01:00:00.000Z", stage: "PRINT" } }))).toContain("EXPORT_OUTCOME_INVALID");
  });

  it("rejects every delivered or reviewed external confirmation", () => {
    const delivered = { state: "DELIVERED", confirmedAt: LATER, authorisedIntegrationId: "x", integrationVersion: "1", externalConfirmationRef: "r" };
    const reviewed = { state: "REVIEWED", deliveredAt: LATER, reviewedAt: LATER, authorisedIntegrationId: "x", integrationVersion: "1", externalConfirmationRef: "r" };
    expect(issuesOf(payload({ externalConfirmation: delivered }))).toContain("EXTERNAL_CONFIRMATION_NOT_ENABLED");
    expect(issuesOf(payload({ externalConfirmation: reviewed }))).toContain("EXTERNAL_CONFIRMATION_NOT_ENABLED");
    expect(issuesOf(payload({ externalConfirmation: { state: "CLINICIAN_CONFIRMED" } })).length).toBeGreaterThan(0);
  });
});

describe("care-summary export revision", () => {
  const revision = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    recordType: "CARE_SUMMARY_EXPORT",
    recordId: id(10),
    revisionId: id(11),
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: AT,
    revisionCreatedAt: AT,
    temporal: { kind: "ATEMPORAL" },
    provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" },
    auditEventId: id(12),
    transactionId: id(13),
    payload: payload(),
    ...overrides,
  });

  it("begins REQUESTED and then records exactly one terminal outcome", () => {
    expect(careSummaryExportRevisionSchema.safeParse(revision()).success).toBe(true);
    expect(careSummaryExportRevisionSchema.safeParse(revision({ payload: payload({ outcome: { state: "FAILED", failedAt: LATER, reason: "PRINT_UNAVAILABLE" } }) })).success).toBe(false);
    const terminal = { action: "UPDATE", revisionNumber: 2, previousRevisionId: id(11), revisionId: id(14) };
    expect(careSummaryExportRevisionSchema.safeParse(revision({ ...terminal, payload: payload({ outcome: { state: "FAILED", failedAt: LATER, reason: "PRINT_UNAVAILABLE" } }) })).success).toBe(true);
    expect(careSummaryExportRevisionSchema.safeParse(revision({ ...terminal, payload: payload() })).success).toBe(false);
    expect(careSummaryExportRevisionSchema.safeParse(revision({ ...terminal, revisionNumber: 3, payload: payload({ outcome: { state: "OUTCOME_UNKNOWN", lastObservedAt: LATER, stage: "PRINT" } }) })).success).toBe(false);
  });

  it("is initiated only by the patient, never by the system or AI", () => {
    expect(careSummaryExportRevisionSchema.safeParse(revision({ provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" } })).success).toBe(false);
    expect(careSummaryExportRevisionSchema.safeParse(revision({ provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "AI_ASSISTED" } })).success).toBe(false);
  });
});
