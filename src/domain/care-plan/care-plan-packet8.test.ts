import { describe, expect, it } from "vitest";
import { reminderPayloadSchema, reminderRevisionSchema } from "./reminder";
import { careQuestionPayloadSchema, careQuestionRevisionSchema } from "./care-question";
import { prescriptionVersionRevisionSchema } from "./care-plan-revisions";
import { coreMedicationPrescriptions } from "../../fixtures/core-medication-prescriptions";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-10-02T13:00:00.000Z";
const PATIENT = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };
const SYSTEM = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);

const reminder = (overrides: Record<string, unknown> = {}) => ({
  label: { text: "Lantus (demo)", language: "und" },
  subject: { kind: "MEDICATION", target: { recordType: "PRESCRIPTION_VERSION", recordId: ID(1), revisionId: ID(2) } },
  schedule: { kind: "WEEKLY_LOCAL", daysOfWeek: ["MONDAY", "SUNDAY"], times: ["21:00"], timeZoneId: "Asia/Singapore" },
  state: "ACTIVE",
  deliveryPreference: "IN_APP_ONLY",
  ...overrides,
});

const revision = (recordType: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  recordType,
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

describe("REMINDER contract", () => {
  it("accepts each structured subject only with its permitted target type", () => {
    expect(reminderPayloadSchema.safeParse(reminder()).success).toBe(true);
    expect(
      reminderPayloadSchema.safeParse(reminder({ subject: { kind: "MEDICATION", target: { recordType: "MEDICATION", recordId: ID(1), revisionId: ID(2) } } }))
        .success,
    ).toBe(false);
    expect(reminderPayloadSchema.safeParse(reminder({ subject: { kind: "CUSTOM" } })).success).toBe(true);
    expect(reminderPayloadSchema.safeParse(reminder({ subject: { kind: "MEASUREMENT", measurementKind: "GLUCOSE" } })).success).toBe(true);
  });

  it("requires unique days and times, a valid timezone and an exact one-time instant", () => {
    const schedule = (value: unknown) => reminderPayloadSchema.safeParse(reminder({ schedule: value })).success;
    expect(schedule({ kind: "WEEKLY_LOCAL", daysOfWeek: ["MONDAY", "MONDAY"], times: ["21:00"], timeZoneId: "Asia/Singapore" })).toBe(false);
    expect(schedule({ kind: "WEEKLY_LOCAL", daysOfWeek: ["MONDAY"], times: ["21:00", "21:00"], timeZoneId: "Asia/Singapore" })).toBe(false);
    expect(schedule({ kind: "WEEKLY_LOCAL", daysOfWeek: [], times: ["21:00"], timeZoneId: "Asia/Singapore" })).toBe(false);
    expect(schedule({ kind: "WEEKLY_LOCAL", daysOfWeek: ["MONDAY"], times: ["25:00"], timeZoneId: "Asia/Singapore" })).toBe(false);
    expect(schedule({ kind: "WEEKLY_LOCAL", daysOfWeek: ["MONDAY"], times: ["21:00"], timeZoneId: "Mars/Olympus" })).toBe(false);
    expect(schedule({ kind: "ONE_TIME", at: { kind: "DATE_ONLY", localDate: "2026-10-02", timeZoneId: "Asia/Singapore" } })).toBe(false);
    expect(schedule({ kind: "ONE_TIME", at: { kind: "EXACT", instantUtc: T0, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 } })).toBe(true);
    expect(
      schedule({
        kind: "RELATIVE_TO_APPOINTMENT",
        appointment: { recordType: "APPOINTMENT", recordId: ID(1), revisionId: ID(2) },
        minutesBefore: -5,
        derivationRuleVersion: "r.1",
      }),
    ).toBe(false);
  });

  it("keeps active, paused, review-required and ended distinct and lets the system only require review", () => {
    for (const state of ["ACTIVE", "PAUSED", "ENDED"]) {
      expect(reminderRevisionSchema.safeParse(revision("REMINDER", reminder({ state }))).success, state).toBe(true);
    }
    expect(issues(reminderRevisionSchema.safeParse(revision("REMINDER", reminder({ state: "REVIEW_REQUIRED" }))))).toContain(
      "NEW_REMINDER_CANNOT_START_IN_REVIEW",
    );
    const systemReview = revision("REMINDER", reminder({ state: "REVIEW_REQUIRED" }), {
      action: "SYSTEM_DERIVE",
      provenance: SYSTEM,
      revisionNumber: 2,
      previousRevisionId: ID(9),
    });
    expect(reminderRevisionSchema.safeParse(systemReview).success).toBe(true);
    expect(issues(reminderRevisionSchema.safeParse({ ...systemReview, payload: reminder({ state: "ACTIVE" }) }))).toContain(
      "SYSTEM_MAY_ONLY_REQUIRE_REVIEW",
    );
    expect(issues(reminderRevisionSchema.safeParse(revision("REMINDER", reminder(), { provenance: SYSTEM })))).toContain(
      "REMINDER_CHANGE_REQUIRES_PATIENT",
    );
  });
});

describe("CARE_QUESTION contract", () => {
  const question = (overrides: Record<string, unknown> = {}) => ({
    questionText: { text: "Can I keep my pen in the car?", language: "en-SG" },
    origin: { kind: "PATIENT_AUTHORED" },
    intendedRecipient: "UNSPECIFIED",
    state: "READY_TO_ASK",
    ...overrides,
  });

  it("accepts a patient-authored question without any system-selected basis", () => {
    expect(careQuestionRevisionSchema.safeParse(revision("CARE_QUESTION", question())).success).toBe(true);
  });

  it("requires a non-empty related basis and the current policy for a JagaOn-prepared question", () => {
    const prepared = (basis: unknown[], purpose = "CLARIFY_REPORTED_PRESCRIPTION") => ({
      kind: "JAGAON_PREPARED",
      purpose,
      basis,
      basisPolicyVersion: "care-question-basis.1",
      preparationRuleVersion: "prep.1",
    });
    const rx = { recordType: "PRESCRIPTION_VERSION", recordId: ID(1), revisionId: ID(2) };
    expect(careQuestionPayloadSchema.safeParse(question({ origin: prepared([rx]), state: "DRAFT" })).success).toBe(true);
    expect(careQuestionPayloadSchema.safeParse(question({ origin: prepared([]), state: "DRAFT" })).success).toBe(false);
    const glucose = { recordType: "GLUCOSE_READING", recordId: ID(1), revisionId: ID(2) };
    expect(issues(careQuestionPayloadSchema.safeParse(question({ origin: prepared([glucose]), state: "DRAFT" })))).toContain(
      "BASIS_TYPE_UNRELATED_TO_PURPOSE",
    );
    expect(issues(careQuestionRevisionSchema.safeParse(revision("CARE_QUESTION", question({ origin: prepared([rx]) }))))).toContain(
      "PREPARED_QUESTION_STARTS_AS_DRAFT",
    );
  });

  it("has no answered, sent, delivered or reviewed state", () => {
    for (const state of ["ANSWERED", "SENT", "DELIVERED", "REVIEWED"]) {
      expect(careQuestionPayloadSchema.safeParse(question({ state })).success, state).toBe(false);
    }
  });
});

describe("PRESCRIPTION_VERSION revision", () => {
  it("uses its exact effective period as the interval temporal meaning", () => {
    const payload = coreMedicationPrescriptions.fixedDoseInsulin;
    const temporal = { kind: "INTERVAL", start: payload.effectivePeriod.start, end: payload.effectivePeriod.end };
    expect(prescriptionVersionRevisionSchema.safeParse(revision("PRESCRIPTION_VERSION", payload, { temporal })).success).toBe(true);
    expect(
      issues(
        prescriptionVersionRevisionSchema.safeParse(
          revision("PRESCRIPTION_VERSION", payload, { temporal: { ...temporal, end: { kind: "UNKNOWN" } } }),
        ),
      ),
    ).toContain("TEMPORAL_DISAGREES_WITH_EFFECTIVE_PERIOD");
  });
});
