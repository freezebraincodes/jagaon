import { describe, expect, it } from "vitest";
import { contextWindowPayloadSchema, contextWindowRevisionSchema } from "./context-window";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-10-02T13:00:00.000Z";
const PATIENT = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };
const SYSTEM = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) => (result.success ? [] : result.error!.issues.map((issue) => issue.message));
const DAY = (localDate: string) => ({ kind: "DATE_ONLY", localDate, timeZoneId: "Asia/Singapore" });

const context = (overrides: Record<string, unknown> = {}) => ({ context: { kind: "TRAVEL" }, state: "PATIENT_REPORTED_ACTIVE", ...overrides });
const revision = (payload: unknown, end: unknown, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  recordType: "CONTEXT_WINDOW",
  recordId: ID(10),
  revisionId: ID(11),
  revisionNumber: 1,
  previousRevisionId: null,
  action: "CREATE",
  recordedAt: T0,
  revisionCreatedAt: T0,
  temporal: { kind: "INTERVAL", start: DAY("2026-09-20"), end },
  provenance: PATIENT,
  auditEventId: ID(12),
  transactionId: ID(13),
  payload,
  ...overrides,
});

describe("CONTEXT_WINDOW contract (domain 7.15–7.17)", () => {
  it("requires a patient label for OTHER and carries no causal or diagnostic field", () => {
    expect(contextWindowPayloadSchema.safeParse(context()).success).toBe(true);
    expect(contextWindowPayloadSchema.safeParse(context({ context: { kind: "OTHER" } })).success).toBe(false);
    expect(contextWindowPayloadSchema.safeParse(context({ context: { kind: "OTHER", label: { text: "Moving house", language: "en-SG" } } })).success).toBe(true);
    expect(contextWindowPayloadSchema.safeParse(context({ context: { kind: "APPETITE_CHANGE", direction: "LESS" } })).success).toBe(true);
    for (const extra of [{ cause: "travel" }, { diagnosis: "flu" }, { affectedGlucose: true }]) expect(contextWindowPayloadSchema.safeParse(context(extra)).success).toBe(false);
    expect(contextWindowPayloadSchema.safeParse(context({ context: { kind: "PRESCRIPTION_CHANGE" } })).success).toBe(false);
  });

  it("validates lifecycle state against the four interval-end meanings", () => {
    const check = (state: string, end: unknown) => contextWindowRevisionSchema.safeParse(revision(context({ state }), end));
    expect(check("PATIENT_REPORTED_ACTIVE", { kind: "OPEN" }).success).toBe(true);
    expect(check("PATIENT_REPORTED_ACTIVE", { kind: "KNOWN", point: DAY("2026-10-10") }).success).toBe(true);
    expect(issues(check("PATIENT_REPORTED_ACTIVE", { kind: "ENDED_TIME_UNKNOWN" }))).toContain("ACTIVE_CONTEXT_CANNOT_HAVE_ENDED_TIME_UNKNOWN");
    expect(check("PATIENT_REPORTED_ENDED", { kind: "ENDED_TIME_UNKNOWN" }).success).toBe(true);
    expect(check("PATIENT_REPORTED_ENDED", { kind: "KNOWN", point: DAY("2026-09-25") }).success).toBe(true);
    expect(issues(check("PATIENT_REPORTED_ENDED", { kind: "OPEN" }))).toContain("ENDED_CONTEXT_REQUIRES_KNOWN_OR_ENDED_TIME_UNKNOWN");
    expect(check("PATIENT_UNSURE", { kind: "UNKNOWN" }).success).toBe(true);
    expect(check("PLANNED", { kind: "KNOWN", point: DAY("2026-10-20") }).success).toBe(true);
  });

  it("uses INTERVAL meaning with patient authority and CREATE/CORRECT/SUPERSEDE only", () => {
    expect(contextWindowRevisionSchema.safeParse(revision(context(), { kind: "OPEN" }, { temporal: { kind: "ATEMPORAL" } })).success).toBe(false);
    expect(issues(contextWindowRevisionSchema.safeParse(revision(context(), { kind: "OPEN" }, { provenance: SYSTEM })))).toContain("CONTEXT_REQUIRES_PATIENT_AUTHORITY");
    expect(issues(contextWindowRevisionSchema.safeParse(revision(context(), { kind: "OPEN" }, { action: "SYSTEM_DERIVE" })))).toContain("UNSUPPORTED_REVISION_ACTION");
  });
});
