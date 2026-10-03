import { describe, expect, it } from "vitest";
import {
  learnedKnowledgePayloadSchema,
  learnedKnowledgeRevisionSchema,
  LEARNED_KNOWLEDGE_REVISION_ACTIONS,
  LEARNED_KNOWLEDGE_DELETION_POLICY,
  type LearnedKnowledgePayload,
} from "./index";

const REC = "11111111-1111-4111-8111-111111111111";
const REV = "22222222-2222-4222-8222-222222222222";
const REC2 = "33333333-3333-4333-8333-333333333333";
const REV2 = "44444444-4444-4444-8444-444444444444";
const REV3 = "55555555-5555-4555-8555-555555555555";

const intakeRef = (revisionId = REV) => ({ recordType: "INTAKE_EVENT", recordId: REC, revisionId });
const contextRef = (revisionId = REV) => ({ recordType: "CONTEXT_WINDOW", recordId: REC2, revisionId });

const observationEvidence = {
  kind: "OBSERVATION_SET",
  supportingRevisions: [intakeRef(REV), intakeRef(REV2)],
  contradictingRevisions: [],
  distinctOccasionCount: 2,
  assessmentPolicyVersion: "familiar-item-learning-policy.v1",
  evaluationRuleVersion: "familiar-item-learning-rule.v1",
};

const familiarContent = {
  kind: "FAMILIAR_ITEM",
  item: {
    kind: "INTAKE_ITEM",
    familiarItemKey: "fik-abc123",
    label: { text: "Kaya toast", language: "und" },
    itemKind: "FOOD",
    intakeContext: { kind: "ANY_RECORDED_INTAKE" },
  },
  scope: { kind: "ORDINARY" },
};

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    content: familiarContent,
    relationship: { kind: "PRIMARY" },
    lifecycle: { state: "EMERGING" },
    evidence: observationEvidence,
    ...overrides,
  };
}

function parses(value: unknown): boolean {
  return learnedKnowledgePayloadSchema.safeParse(value).success;
}

describe("LEARNED_KNOWLEDGE shared payload", () => {
  it("accepts a familiar-item observation-set proposition", () => {
    expect(parses(payload())).toBe(true);
  });

  it("rejects unknown keys at every level", () => {
    expect(parses({ ...(payload() as object), confidence: 0.83 })).toBe(false);
    expect(parses(payload({ content: { ...familiarContent, note: "x" } }))).toBe(false);
    expect(parses(payload({ lifecycle: { state: "EMERGING", score: 1 } }))).toBe(false);
    expect(parses(payload({ evidence: { ...observationEvidence, extra: true } }))).toBe(false);
  });

  it("rejects INSUFFICIENT and other unpersisted lifecycle states", () => {
    expect(parses(payload({ lifecycle: { state: "INSUFFICIENT" } }))).toBe(false);
    expect(parses(payload({ lifecycle: { state: "ESTABLISHED" } }))).toBe(false);
  });

  it("requires an activation basis for ACTIVE and WEAKENING", () => {
    expect(parses(payload({ lifecycle: { state: "ACTIVE" } }))).toBe(false);
    expect(
      parses(
        payload({
          lifecycle: {
            state: "ACTIVE",
            activation: { kind: "LOW_CONSEQUENCE_POLICY", policyVersion: "familiar-item-activation.v1" },
          },
        }),
      ),
    ).toBe(true);
    expect(
      parses(payload({ lifecycle: { state: "WEAKENING", previousActivation: { kind: "PATIENT_CONFIRMED" } } })),
    ).toBe(true);
  });

  it("requires ADOPTED to name the adopting revision", () => {
    expect(parses(payload({ lifecycle: { state: "ADOPTED" } }))).toBe(false);
    expect(
      parses(
        payload({
          lifecycle: {
            state: "ADOPTED",
            adoptedAs: { recordType: "LEARNED_KNOWLEDGE", recordId: REC2, revisionId: REV2 },
          },
        }),
      ),
    ).toBe(true);
  });

  it("requires a learned-knowledge reference for a proposed replacement", () => {
    expect(
      parses(
        payload({
          relationship: {
            kind: "PROPOSED_REPLACEMENT",
            replaces: { recordType: "LEARNED_KNOWLEDGE", recordId: REC2, revisionId: REV2 },
          },
        }),
      ),
    ).toBe(true);
    expect(
      parses(payload({ relationship: { kind: "PROPOSED_REPLACEMENT", replaces: intakeRef() } })),
    ).toBe(false);
  });

  it("rejects empty, duplicate and inflated observation evidence", () => {
    expect(parses(payload({ evidence: { ...observationEvidence, supportingRevisions: [] } }))).toBe(false);
    expect(
      parses(payload({ evidence: { ...observationEvidence, supportingRevisions: [intakeRef(), intakeRef()] } })),
    ).toBe(false);
    expect(parses(payload({ evidence: { ...observationEvidence, distinctOccasionCount: 0 } }))).toBe(false);
    expect(parses(payload({ evidence: { ...observationEvidence, distinctOccasionCount: 3 } }))).toBe(false);
    expect(parses(payload({ evidence: { ...observationEvidence, distinctOccasionCount: 1.5 } }))).toBe(false);
    expect(
      parses(payload({ evidence: { ...observationEvidence, contradictingRevisions: [intakeRef(REV)] } })),
    ).toBe(false);
  });

  it("accepts a direct patient statement without inventing an observation", () => {
    expect(
      parses(
        payload({
          lifecycle: { state: "ACTIVE", activation: { kind: "PATIENT_STATED" } },
          evidence: {
            kind: "DIRECT_PATIENT_STATEMENT",
            relatedRevisions: [],
            contradictingRevisions: [],
            assessmentPolicyVersion: "statement-policy.v1",
            evaluationRuleVersion: "statement-rule.v1",
          },
        }),
      ),
    ).toBe(true);
  });

  it("forbids low-consequence activation from a patient statement", () => {
    expect(
      parses(
        payload({
          lifecycle: { state: "ACTIVE", activation: { kind: "LOW_CONSEQUENCE_POLICY", policyVersion: "p.v1" } },
          evidence: {
            kind: "DIRECT_PATIENT_STATEMENT",
            relatedRevisions: [],
            contradictingRevisions: [],
            assessmentPolicyVersion: "statement-policy.v1",
            evaluationRuleVersion: "statement-rule.v1",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("routine content", () => {
  const routine = (pattern: unknown, subject: unknown = { kind: "INTAKE_SLOT_TIMING", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" } }) =>
    payload({ content: { kind: "ROUTINE", subject, pattern, scope: { kind: "ORDINARY" } } });
  const window = (start: string, end: string, crossesMidnight: boolean) => ({
    kind: "LOCAL_TIME_WINDOW",
    start,
    end,
    crossesMidnight,
    timeZoneId: "Asia/Singapore",
  });

  it("accepts ordinary and midnight-crossing windows", () => {
    expect(parses(routine(window("07:15", "07:45", false)))).toBe(true);
    expect(parses(routine(window("23:00", "01:00", true)))).toBe(true);
  });

  it("rejects an inconsistent midnight flag, equal times and invalid zones", () => {
    expect(parses(routine(window("23:00", "01:00", false)))).toBe(false);
    expect(parses(routine(window("07:15", "07:45", true)))).toBe(false);
    expect(parses(routine(window("07:15", "07:15", false)))).toBe(false);
    expect(parses(routine({ ...window("07:15", "07:45", false), timeZoneId: "Mars/Base" }))).toBe(false);
  });

  it("requires unique non-empty days", () => {
    expect(parses(routine({ kind: "DAYS_OF_WEEK", days: ["MONDAY", "FRIDAY"] }))).toBe(true);
    expect(parses(routine({ kind: "DAYS_OF_WEEK", days: [] }))).toBe(false);
    expect(parses(routine({ kind: "DAYS_OF_WEEK", days: ["MONDAY", "MONDAY"] }))).toBe(false);
  });

  it("requires a label for OTHER activity and keeps measurement kinds closed", () => {
    const days = { kind: "DAYS_OF_WEEK", days: ["MONDAY"] };
    expect(parses(routine(days, { kind: "ACTIVITY_TIMING", activityCategory: "WALKING" }))).toBe(true);
    expect(parses(routine(days, { kind: "ACTIVITY_TIMING", activityCategory: "OTHER" }))).toBe(false);
    expect(
      parses(routine(days, { kind: "ACTIVITY_TIMING", activityCategory: "OTHER", patientLabel: "Tai chi" })),
    ).toBe(true);
    expect(parses(routine(days, { kind: "MEASUREMENT_TIMING", measurementKind: "BLOOD_PRESSURE" }))).toBe(false);
  });

  it("forbids learning a medication or prescription as a routine subject", () => {
    expect(
      parses(routine({ kind: "DAYS_OF_WEEK", days: ["MONDAY"] }, { kind: "MEDICATION_TIMING", medication: "Lantus" })),
    ).toBe(false);
  });
});

describe("behaviour content", () => {
  const behaviour = (tendency: unknown, scheduleKey?: string) =>
    payload({
      content: {
        kind: "BEHAVIOUR",
        subject: {
          kind: "MEDICATION_EVENT_TIMING",
          prescriptionVersion: { recordType: "PRESCRIPTION_VERSION", recordId: REC2, revisionId: REV2 },
          ...(scheduleKey === undefined ? {} : { scheduleKey }),
        },
        tendency,
        scope: { kind: "ORDINARY" },
      },
      lifecycle: { state: "CANDIDATE" },
    });

  it("accepts signed offsets and rejects an inverted window", () => {
    expect(parses(behaviour({ kind: "RECORDED_OFFSET_WINDOW", minimumMinutes: -10, maximumMinutes: 25 }))).toBe(true);
    expect(parses(behaviour({ kind: "RECORDED_OFFSET_WINDOW", minimumMinutes: 30, maximumMinutes: 5 }))).toBe(false);
    expect(parses(behaviour({ kind: "RECORDED_OFFSET_WINDOW", minimumMinutes: 0.5, maximumMinutes: 5 }))).toBe(false);
  });

  it("rejects an empty schedule key and low-consequence activation", () => {
    expect(parses(behaviour({ kind: "RECORDED_OFFSET_WINDOW", minimumMinutes: 0, maximumMinutes: 5 }, ""))).toBe(false);
    expect(
      learnedKnowledgePayloadSchema.safeParse({
        ...(behaviour({ kind: "RECORDED_OFFSET_WINDOW", minimumMinutes: 0, maximumMinutes: 5 }) as object),
        lifecycle: { state: "ACTIVE", activation: { kind: "LOW_CONSEQUENCE_POLICY", policyVersion: "p.v1" } },
      }).success,
    ).toBe(false);
  });
});

describe("preference, context, barrier and familiar-item content", () => {
  it("accepts a quick-entry preference referencing learned knowledge only", () => {
    const preference = (familiarItem: unknown) =>
      payload({
        content: { kind: "PREFERENCE", preference: { kind: "QUICK_ENTRY_ITEM", familiarItem, disposition: "HIDE" } },
        lifecycle: { state: "ACTIVE", activation: { kind: "PATIENT_STATED" } },
        evidence: {
          kind: "DIRECT_PATIENT_STATEMENT",
          relatedRevisions: [],
          contradictingRevisions: [],
          assessmentPolicyVersion: "statement-policy.v1",
          evaluationRuleVersion: "statement-rule.v1",
        },
      });
    expect(parses(preference({ recordType: "LEARNED_KNOWLEDGE", recordId: REC2, revisionId: REV2 }))).toBe(true);
    expect(parses(preference(intakeRef()))).toBe(false);
  });

  it("requires labels for patient-defined contexts and rejects health contexts", () => {
    const context = (value: unknown) =>
      payload({ content: { kind: "CONTEXT", context: value, recurrence: { kind: "REPEATED_UNSCHEDULED" } } });
    expect(parses(context({ kind: "RECURRING_STANDARD_CONTEXT", contextKind: "TRAVEL" }))).toBe(true);
    expect(parses(context({ kind: "RECURRING_STANDARD_CONTEXT", contextKind: "FEELING_UNWELL" }))).toBe(false);
    expect(parses(context({ kind: "RECURRING_PATIENT_DEFINED_CONTEXT", contextKey: "ctx-1" }))).toBe(false);
    expect(
      parses(
        context({
          kind: "RECURRING_PATIENT_DEFINED_CONTEXT",
          contextKey: "ctx-1",
          label: { text: "Visiting my daughter", language: "en-SG" },
        }),
      ),
    ).toBe(true);
  });

  it("keeps barrier tasks closed, contexts unique and forbids automatic activation", () => {
    const barrier = (scope: unknown, lifecycle: unknown = { state: "CANDIDATE" }) =>
      payload({
        content: {
          kind: "BARRIER",
          barrier: { kind: "CATEGORISED", barrierKey: "bk-1", category: "REMEMBERING" },
          affectedTask: { kind: "MEASUREMENT", activity: "RECORDING_RESULT", measurementKind: "GLUCOSE" },
          scope,
        },
        lifecycle,
      });
    expect(parses(barrier({ kind: "ORDINARY" }))).toBe(true);
    expect(parses(barrier({ kind: "CONTEXT_BOUND", contexts: [contextRef(REV), contextRef(REV)] }))).toBe(false);
    expect(parses(barrier({ kind: "CONTEXT_BOUND", contexts: [] }))).toBe(false);
    expect(
      parses(
        barrier(
          { kind: "ORDINARY" },
          { state: "ACTIVE", activation: { kind: "LOW_CONSEQUENCE_POLICY", policyVersion: "p.v1" } },
        ),
      ),
    ).toBe(false);
  });

  it("keeps a familiar intake slot consistent with its intake kind", () => {
    const item = (intakeContext: unknown) =>
      payload({ content: { ...familiarContent, item: { ...familiarContent.item, intakeContext } } });
    expect(
      parses(item({ kind: "SPECIFIC_INTAKE_KIND", intakeKind: "MEAL", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" } })),
    ).toBe(true);
    expect(
      parses(item({ kind: "SPECIFIC_INTAKE_KIND", intakeKind: "SNACK", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" } })),
    ).toBe(false);
  });

  it("rejects UNKNOWN familiar items and medication identities", () => {
    const withItem = (item: unknown) => payload({ content: { ...familiarContent, item } });
    expect(parses(withItem({ ...familiarContent.item, itemKind: "UNKNOWN" }))).toBe(false);
    expect(parses(withItem({ ...familiarContent.item, kind: "MEDICATION" }))).toBe(false);
    expect(
      parses(
        withItem({
          kind: "ACTIVITY",
          familiarItemKey: "fik-walk",
          label: { text: "Morning walk", language: "und" },
          activityCategory: "WALKING",
        }),
      ),
    ).toBe(true);
  });
});

describe("LEARNED_KNOWLEDGE revision envelope", () => {
  const revision = {
    schemaVersion: 1,
    recordType: "LEARNED_KNOWLEDGE",
    recordId: REC2,
    revisionId: REV3,
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: "2026-10-03T01:00:00.000Z",
    revisionCreatedAt: "2026-10-03T01:00:00.000Z",
    temporal: { kind: "ATEMPORAL" },
    provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" },
    auditEventId: "66666666-6666-4666-8666-666666666666",
    transactionId: "77777777-7777-4777-8777-777777777777",
    payload: payload() as LearnedKnowledgePayload,
  };

  it("accepts an atemporal system-derived revision", () => {
    expect(learnedKnowledgeRevisionSchema.safeParse(revision).success).toBe(true);
  });

  it("rejects point temporal meaning and an invalid provenance combination", () => {
    expect(
      learnedKnowledgeRevisionSchema.safeParse({
        ...revision,
        temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } },
      }).success,
    ).toBe(false);
    expect(
      learnedKnowledgeRevisionSchema.safeParse({
        ...revision,
        provenance: { ...revision.provenance, initiator: "PATIENT" },
      }).success,
    ).toBe(false);
  });

  it("declares patient-deletable handling and closed revision actions", () => {
    expect(LEARNED_KNOWLEDGE_DELETION_POLICY).toBe("PATIENT_DELETABLE");
    expect([...LEARNED_KNOWLEDGE_REVISION_ACTIONS]).toEqual(["CREATE", "UPDATE", "CONFIRM", "REJECT", "SUPERSEDE"]);
    expect(learnedKnowledgeRevisionSchema.safeParse({ ...revision, action: "EXPIRE" }).success).toBe(false);
  });
});
