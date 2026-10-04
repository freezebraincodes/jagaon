import { describe, expect, it } from "vitest";
import { APPOINTMENT_SERVICE_CATALOGUE, appointmentPayloadSchema, appointmentRevisionSchema } from "./appointment";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-10-02T13:00:00.000Z";
const PATIENT = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };
const SYSTEM = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) => (result.success ? [] : result.error!.issues.map((issue) => issue.message));

const appointment = (overrides: Record<string, unknown> = {}) => ({
  appointmentLabel: "Dr Lim, Bukit Merah Polyclinic",
  service: { kind: "PATIENT_DEFINED", serviceGroup: "CONDITION_REVIEW", label: "Diabetes review" },
  mode: "IN_PERSON",
  status: "SCHEDULED",
  ...overrides,
});
const EXACT = { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: "2026-10-14T01:40:00.000Z", timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 } };
const revision = (payload: unknown, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  recordType: "APPOINTMENT",
  recordId: ID(10),
  revisionId: ID(11),
  revisionNumber: 1,
  previousRevisionId: null,
  action: "CREATE",
  recordedAt: T0,
  revisionCreatedAt: T0,
  temporal: EXACT,
  provenance: PATIENT,
  auditEventId: ID(12),
  transactionId: ID(13),
  payload,
  ...overrides,
});

describe("APPOINTMENT contract (domain 7.5–7.8)", () => {
  it("keeps service groups condition-neutral with a versioned reviewed catalogue identity", () => {
    expect(appointmentPayloadSchema.safeParse(appointment()).success).toBe(true);
    const entry = APPOINTMENT_SERVICE_CATALOGUE.entries[0]!;
    const catalogued = { kind: "REVIEWED_CATALOGUE_MATCH", catalogueEntryKey: entry.key, catalogueVersion: APPOINTMENT_SERVICE_CATALOGUE.version, serviceGroup: entry.serviceGroup, label: entry.labels["en-SG"] };
    expect(appointmentPayloadSchema.safeParse(appointment({ service: catalogued })).success).toBe(true);
    expect(issues(appointmentPayloadSchema.safeParse(appointment({ service: { ...catalogued, serviceGroup: "DENTAL_CARE" } })))).toContain("SERVICE_GROUP_DISAGREES_WITH_CATALOGUE");
    expect(appointmentPayloadSchema.safeParse(appointment({ service: { kind: "UNKNOWN" } })).success).toBe(true);
    expect(appointmentPayloadSchema.safeParse(appointment({ service: { kind: "PATIENT_DEFINED", serviceGroup: "HYPERTENSION", label: "x" } })).success).toBe(false);
  });

  it("allows multiple optional references that are not proof of completion", () => {
    const ref = (n: number) => ({ recordType: "PREVENTIVE_CARE_ITEM", recordId: ID(n), revisionId: ID(n + 1) });
    expect(appointmentPayloadSchema.safeParse(appointment({ relatedPreventiveCareItems: [ref(30), ref(40)] })).success).toBe(true);
    expect(appointmentPayloadSchema.safeParse(appointment({ relatedPreventiveCareItems: [] })).success).toBe(false);
    expect(appointmentPayloadSchema.safeParse(appointment({ attended: true })).success).toBe(false);
  });

  it("requires at least a known scheduled date and never an unknown one", () => {
    expect(appointmentRevisionSchema.safeParse(revision(appointment())).success).toBe(true);
    expect(appointmentRevisionSchema.safeParse(revision(appointment(), { temporal: { kind: "POINT", occurrence: { kind: "DATE_ONLY", localDate: "2026-10-14", timeZoneId: "Asia/Singapore" } } })).success).toBe(true);
    expect(issues(appointmentRevisionSchema.safeParse(revision(appointment(), { temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } } })))).toContain("APPOINTMENT_REQUIRES_SCHEDULED_DATE");
    expect(appointmentRevisionSchema.safeParse(revision(appointment(), { temporal: { kind: "ATEMPORAL" } })).success).toBe(false);
  });

  it("lets only the patient change status; the system never marks an appointment missed", () => {
    const corrected = { revisionId: ID(14), revisionNumber: 2, previousRevisionId: ID(11), action: "SUPERSEDE" };
    expect(appointmentRevisionSchema.safeParse(revision(appointment({ status: "PATIENT_REPORTED_ATTENDED" }), corrected)).success).toBe(true);
    expect(issues(appointmentRevisionSchema.safeParse(revision(appointment({ status: "PATIENT_REPORTED_MISSED" }), { ...corrected, provenance: SYSTEM })))).toContain(
      "APPOINTMENT_CHANGE_REQUIRES_PATIENT",
    );
    expect(issues(appointmentRevisionSchema.safeParse(revision(appointment(), { action: "SYSTEM_DERIVE" })))).toContain("UNSUPPORTED_REVISION_ACTION");
  });
});
