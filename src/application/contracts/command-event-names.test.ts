import { describe, it, expect } from "vitest";
import {
  // Command name catalogues
  PATIENT_SETTINGS_COMMAND_NAMES,
  patientSettingsCommandNameSchema,
  CARE_PLAN_COMMAND_NAMES,
  carePlanCommandNameSchema,
  HEALTH_RECORD_COMMAND_NAMES,
  healthRecordCommandNameSchema,
  PATIENT_CONTROL_COMMAND_NAMES,
  patientControlCommandNameSchema,
  LEARNING_PATTERN_COMMAND_NAMES,
  learningPatternCommandNameSchema,
  INQUIRY_COMMAND_NAMES,
  inquiryCommandNameSchema,
  SAFETY_COMMAND_NAMES,
  safetyCommandNameSchema,
  CARE_PREPARATION_COMMAND_NAMES,
  carePreparationCommandNameSchema,
  COMMAND_NAMES,
  commandNameSchema,
  // Event name catalogues
  PATIENT_SETTINGS_EVENT_NAMES,
  patientSettingsEventNameSchema,
  CARE_PLAN_EVENT_NAMES,
  carePlanEventNameSchema,
  HEALTH_RECORD_EVENT_NAMES,
  healthRecordEventNameSchema,
  LEARNING_EVENT_NAMES,
  learningEventNameSchema,
  PATTERN_EVENT_NAMES,
  patternEventNameSchema,
  INQUIRY_EVENT_NAMES,
  inquiryEventNameSchema,
  SAFETY_EVENT_NAMES,
  safetyEventNameSchema,
  CARE_PREPARATION_EVENT_NAMES,
  carePreparationEventNameSchema,
  DOMAIN_EVENT_NAMES,
  domainEventNameSchema,
} from "./command-event-names";

// ---------------------------------------------------------------------------
// Independent, spec-backed expected arrays.
//
// Every array below is written directly from the Event Contracts specification
// (Sections 5.1, 6.2–6.5, 7.1–7.4, 8.1–8.4, 9.1–9.4) and is NOT derived from
// the implementation catalogue arrays being tested.
// ---------------------------------------------------------------------------

// --- Command-name families (Sections 6.2–6.5, 7.1–7.4) --------------------

const EXPECTED_PATIENT_SETTINGS_COMMAND_NAMES = [
  "CREATE_PATIENT_PROFILE",
  "REVISE_PATIENT_PROFILE",
  "SET_PATIENT_PREFERENCE",
  "CORRECT_PATIENT_PREFERENCE",
  "RECORD_CONDITION",
  "REVISE_CONDITION",
  // Packet 13 (P13S, Q13-8): patient terminology (owner storage decision 2026-10-09).
  "REMEMBER_PATIENT_TERM",
  "CHANGE_PATIENT_TERM",
] as const;

const EXPECTED_CARE_PLAN_COMMAND_NAMES = [
  "REGISTER_MEDICATION",
  "REVISE_MEDICATION",
  "RECORD_PRESCRIPTION_VERSION",
  "REVISE_PRESCRIPTION_VERSION",
  "REPORT_PRESCRIPTION_CHANGE",
  "TRANSITION_PRESCRIPTION_CHANGE_CANDIDATE",
  "CREATE_PREVENTIVE_CARE_ITEM",
  "REVISE_PREVENTIVE_CARE_ITEM",
  "SCHEDULE_APPOINTMENT",
  "REVISE_APPOINTMENT",
  "CREATE_CARE_QUESTION",
  "REVISE_CARE_QUESTION",
  "CREATE_REMINDER",
  "REVISE_REMINDER",
] as const;

const EXPECTED_HEALTH_RECORD_COMMAND_NAMES = [
  "RECORD_GLUCOSE_READING",
  "RECORD_KETONE_READING",
  "RECORD_INTAKE_EVENT",
  "RECORD_SYMPTOM_REPORT",
  "RECORD_ACTIVITY_EVENT",
  "RECORD_MEDICATION_EVENT",
  "RECORD_BODY_MEASUREMENT",
  "RECORD_PREVENTIVE_CARE_OUTCOME",
  "RECORD_CONTEXT_WINDOW",
  "CORRECT_HEALTH_RECORD",
  "REVISE_CONTEXT_WINDOW",
] as const;

const EXPECTED_PATIENT_CONTROL_COMMAND_NAMES = [
  "DELETE_PATIENT_RECORD",
] as const;

const EXPECTED_LEARNING_PATTERN_COMMAND_NAMES = [
  "REEVALUATE_LEARNING",
  "CONFIRM_LEARNED_KNOWLEDGE",
  "REJECT_LEARNED_KNOWLEDGE",
  "RETIRE_LEARNED_KNOWLEDGE",
  "REEVALUATE_PATTERN_FAMILY",
  "TRANSITION_PATTERN_OBSERVATION",
] as const;

const EXPECTED_INQUIRY_COMMAND_NAMES = [
  "CREATE_INQUIRY_CANDIDATE",
  "TRANSITION_INQUIRY",
  "ANSWER_INQUIRY",
  "CORRECT_INQUIRY_RESPONSE",
  "PROCESS_INQUIRY_RESPONSE",
] as const;

const EXPECTED_SAFETY_COMMAND_NAMES = [
  "RECORD_SAFETY_DELIVERY_ATTEMPT",
  "TRANSITION_SAFETY_DELIVERY_ATTEMPT",
  "ACKNOWLEDGE_SAFETY_PRESENTATION",
  "LINK_SAFETY_RELATED_ACTION",
  "LINK_SAFETY_RECHECK",
  "REEVALUATE_SAFETY_EVENT",
] as const;

const EXPECTED_CARE_PREPARATION_COMMAND_NAMES = [
  "PREPARE_CARE_SUMMARY",
  "MARK_CARE_SUMMARY_PREVIEWED",
  "APPROVE_CARE_SUMMARY",
  "INVALIDATE_CARE_SUMMARY",
  "SUPERSEDE_CARE_SUMMARY",
  "REQUEST_CARE_SUMMARY_EXPORT",
  "COMPLETE_CARE_SUMMARY_EXPORT",
] as const;

// Combined CommandName — Section 5.1 union order.
const EXPECTED_COMMAND_NAMES = [
  ...EXPECTED_PATIENT_SETTINGS_COMMAND_NAMES,
  ...EXPECTED_CARE_PLAN_COMMAND_NAMES,
  ...EXPECTED_HEALTH_RECORD_COMMAND_NAMES,
  ...EXPECTED_PATIENT_CONTROL_COMMAND_NAMES,
  ...EXPECTED_LEARNING_PATTERN_COMMAND_NAMES,
  ...EXPECTED_INQUIRY_COMMAND_NAMES,
  ...EXPECTED_SAFETY_COMMAND_NAMES,
  ...EXPECTED_CARE_PREPARATION_COMMAND_NAMES,
] as const;

// --- Event-name families (Sections 8.1–8.4, 9.1–9.4) ----------------------

const EXPECTED_PATIENT_SETTINGS_EVENT_NAMES = [
  "PATIENT_PROFILE_CREATED",
  "PATIENT_PROFILE_REVISED",
  "PATIENT_PREFERENCE_SET",
  "PATIENT_PREFERENCE_CORRECTED",
  "CONDITION_RECORDED",
  "CONDITION_REVISED",
  // Packet 13 (P13S, Q13-8).
  "PATIENT_TERM_REMEMBERED",
  "PATIENT_TERM_CHANGED",
] as const;

const EXPECTED_CARE_PLAN_EVENT_NAMES = [
  "MEDICATION_REGISTERED",
  "MEDICATION_REVISED",
  "PRESCRIPTION_VERSION_RECORDED",
  "PRESCRIPTION_VERSION_REVISED",
  "PRESCRIPTION_CHANGE_REPORTED",
  "PRESCRIPTION_CHANGE_CANDIDATE_TRANSITIONED",
  "PREVENTIVE_CARE_ITEM_CREATED",
  "PREVENTIVE_CARE_ITEM_REVISED",
  "APPOINTMENT_SCHEDULED",
  "APPOINTMENT_REVISED",
  "CARE_QUESTION_CREATED",
  "CARE_QUESTION_REVISED",
  "REMINDER_CREATED",
  "REMINDER_REVISED",
] as const;

const EXPECTED_HEALTH_RECORD_EVENT_NAMES = [
  "GLUCOSE_READING_RECORDED",
  "GLUCOSE_READING_CORRECTED",
  "KETONE_READING_RECORDED",
  "KETONE_READING_CORRECTED",
  "INTAKE_EVENT_RECORDED",
  "INTAKE_EVENT_CORRECTED",
  "SYMPTOM_REPORT_RECORDED",
  "SYMPTOM_REPORT_CORRECTED",
  "ACTIVITY_EVENT_RECORDED",
  "ACTIVITY_EVENT_CORRECTED",
  "MEDICATION_EVENT_RECORDED",
  "MEDICATION_EVENT_CORRECTED",
  "BODY_MEASUREMENT_RECORDED",
  "BODY_MEASUREMENT_CORRECTED",
  "PREVENTIVE_CARE_OUTCOME_RECORDED",
  "PREVENTIVE_CARE_OUTCOME_CORRECTED",
  "CONTEXT_WINDOW_RECORDED",
  "CONTEXT_WINDOW_REVISED",
] as const;

const EXPECTED_LEARNING_EVENT_NAMES = [
  "LEARNED_KNOWLEDGE_CREATED",
  "LEARNED_KNOWLEDGE_REVISED",
  "LEARNED_KNOWLEDGE_CONFIRMED",
  "LEARNED_KNOWLEDGE_REJECTED",
  "LEARNED_KNOWLEDGE_TRANSITIONED",
] as const;

const EXPECTED_PATTERN_EVENT_NAMES = [
  "PATTERN_EVIDENCE_SNAPSHOT_CREATED",
  "PATTERN_OBSERVATION_CREATED",
  "PATTERN_OBSERVATION_REVISED",
  "PATTERN_OBSERVATION_TRANSITIONED",
] as const;

const EXPECTED_INQUIRY_EVENT_NAMES = [
  "INQUIRY_CREATED",
  "INQUIRY_TRANSITIONED",
  "INQUIRY_RESPONSE_RECORDED",
  "INQUIRY_RESPONSE_CORRECTED",
  "INQUIRY_RESPONSE_PROCESSING_TRANSITIONED",
] as const;

const EXPECTED_SAFETY_EVENT_NAMES = [
  "SAFETY_EVENT_OPENED",
  "SAFETY_EVENT_REEVALUATED",
  "SAFETY_EVENT_TRANSITIONED",
  "SAFETY_PRESENTATION_ACKNOWLEDGED",
  "SAFETY_RELATED_ACTION_LINKED",
  "SAFETY_RECHECK_LINKED",
  "SAFETY_DELIVERY_ATTEMPT_RECORDED",
  "SAFETY_DELIVERY_ATTEMPT_TRANSITIONED",
] as const;

const EXPECTED_CARE_PREPARATION_EVENT_NAMES = [
  "CARE_SUMMARY_SNAPSHOT_PREPARED",
  "CARE_SUMMARY_SNAPSHOT_PREVIEWED",
  "CARE_SUMMARY_SNAPSHOT_APPROVED",
  "CARE_SUMMARY_SNAPSHOT_INVALIDATED",
  "CARE_SUMMARY_SNAPSHOT_SUPERSEDED",
  "CARE_SUMMARY_EXPORT_REQUESTED",
  "CARE_SUMMARY_EXPORT_OUTCOME_RECORDED",
] as const;

const EXPECTED_PATIENT_RECORD_DELETED_EVENT_NAMES = [
  "PATIENT_RECORD_DELETED",
] as const;

// Combined DomainEventName — Section 5.1 union order.
const EXPECTED_DOMAIN_EVENT_NAMES = [
  ...EXPECTED_PATIENT_SETTINGS_EVENT_NAMES,
  ...EXPECTED_CARE_PLAN_EVENT_NAMES,
  ...EXPECTED_HEALTH_RECORD_EVENT_NAMES,
  ...EXPECTED_LEARNING_EVENT_NAMES,
  ...EXPECTED_PATTERN_EVENT_NAMES,
  ...EXPECTED_INQUIRY_EVENT_NAMES,
  ...EXPECTED_SAFETY_EVENT_NAMES,
  ...EXPECTED_CARE_PREPARATION_EVENT_NAMES,
  ...EXPECTED_PATIENT_RECORD_DELETED_EVENT_NAMES,
] as const;

// ===========================================================================
// Command name catalogue tests
// ===========================================================================

describe("PatientSettingsCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...PATIENT_SETTINGS_COMMAND_NAMES]).toEqual([
      ...EXPECTED_PATIENT_SETTINGS_COMMAND_NAMES,
    ]);
  });

  it.each(PATIENT_SETTINGS_COMMAND_NAMES)("accepts %s", (name) => {
    expect(patientSettingsCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => patientSettingsCommandNameSchema.parse("UNKNOWN")).toThrow();
    expect(() => patientSettingsCommandNameSchema.parse("")).toThrow();
  });
});

describe("CarePlanCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...CARE_PLAN_COMMAND_NAMES]).toEqual([
      ...EXPECTED_CARE_PLAN_COMMAND_NAMES,
    ]);
  });

  it.each(CARE_PLAN_COMMAND_NAMES)("accepts %s", (name) => {
    expect(carePlanCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => carePlanCommandNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("HealthRecordCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...HEALTH_RECORD_COMMAND_NAMES]).toEqual([
      ...EXPECTED_HEALTH_RECORD_COMMAND_NAMES,
    ]);
  });

  it.each(HEALTH_RECORD_COMMAND_NAMES)("accepts %s", (name) => {
    expect(healthRecordCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => healthRecordCommandNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("PatientControlCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...PATIENT_CONTROL_COMMAND_NAMES]).toEqual([
      ...EXPECTED_PATIENT_CONTROL_COMMAND_NAMES,
    ]);
  });

  it.each(PATIENT_CONTROL_COMMAND_NAMES)("accepts %s", (name) => {
    expect(patientControlCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => patientControlCommandNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("LearningPatternCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...LEARNING_PATTERN_COMMAND_NAMES]).toEqual([
      ...EXPECTED_LEARNING_PATTERN_COMMAND_NAMES,
    ]);
  });

  it.each(LEARNING_PATTERN_COMMAND_NAMES)("accepts %s", (name) => {
    expect(learningPatternCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => learningPatternCommandNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("InquiryCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...INQUIRY_COMMAND_NAMES]).toEqual([
      ...EXPECTED_INQUIRY_COMMAND_NAMES,
    ]);
  });

  it.each(INQUIRY_COMMAND_NAMES)("accepts %s", (name) => {
    expect(inquiryCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => inquiryCommandNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("SafetyCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...SAFETY_COMMAND_NAMES]).toEqual([
      ...EXPECTED_SAFETY_COMMAND_NAMES,
    ]);
  });

  it.each(SAFETY_COMMAND_NAMES)("accepts %s", (name) => {
    expect(safetyCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => safetyCommandNameSchema.parse("UNKNOWN")).toThrow();
  });

  it("rejects CREATE_SAFETY_EVENT", () => {
    expect(() => safetyCommandNameSchema.parse("CREATE_SAFETY_EVENT")).toThrow();
    expect(() => commandNameSchema.parse("CREATE_SAFETY_EVENT")).toThrow();
  });
});

describe("CarePreparationCommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...CARE_PREPARATION_COMMAND_NAMES]).toEqual([
      ...EXPECTED_CARE_PREPARATION_COMMAND_NAMES,
    ]);
  });

  it.each(CARE_PREPARATION_COMMAND_NAMES)("accepts %s", (name) => {
    expect(carePreparationCommandNameSchema.parse(name)).toBe(name);
    expect(commandNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => carePreparationCommandNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("combined CommandName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...COMMAND_NAMES]).toEqual([...EXPECTED_COMMAND_NAMES]);
  });

  it("catalogue contains no duplicates", () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  });

  it("accepts every approved command name", () => {
    for (const name of EXPECTED_COMMAND_NAMES) {
      expect(commandNameSchema.parse(name)).toBe(name);
    }
  });

  it("rejects MUTATE_RECORD", () => {
    expect(() => commandNameSchema.parse("MUTATE_RECORD")).toThrow();
  });

  it("rejects unknown names", () => {
    expect(() => commandNameSchema.parse("UNKNOWN_COMMAND")).toThrow();
    expect(() => commandNameSchema.parse("")).toThrow();
  });
});

// ===========================================================================
// Event name catalogue tests
// ===========================================================================

describe("PatientSettingsEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...PATIENT_SETTINGS_EVENT_NAMES]).toEqual([
      ...EXPECTED_PATIENT_SETTINGS_EVENT_NAMES,
    ]);
  });

  it.each(PATIENT_SETTINGS_EVENT_NAMES)("accepts %s", (name) => {
    expect(patientSettingsEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => patientSettingsEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("CarePlanEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...CARE_PLAN_EVENT_NAMES]).toEqual([
      ...EXPECTED_CARE_PLAN_EVENT_NAMES,
    ]);
  });

  it.each(CARE_PLAN_EVENT_NAMES)("accepts %s", (name) => {
    expect(carePlanEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => carePlanEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("HealthRecordEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...HEALTH_RECORD_EVENT_NAMES]).toEqual([
      ...EXPECTED_HEALTH_RECORD_EVENT_NAMES,
    ]);
  });

  it.each(HEALTH_RECORD_EVENT_NAMES)("accepts %s", (name) => {
    expect(healthRecordEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => healthRecordEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("LearningEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...LEARNING_EVENT_NAMES]).toEqual([
      ...EXPECTED_LEARNING_EVENT_NAMES,
    ]);
  });

  it.each(LEARNING_EVENT_NAMES)("accepts %s", (name) => {
    expect(learningEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => learningEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("PatternEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...PATTERN_EVENT_NAMES]).toEqual([
      ...EXPECTED_PATTERN_EVENT_NAMES,
    ]);
  });

  it.each(PATTERN_EVENT_NAMES)("accepts %s", (name) => {
    expect(patternEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => patternEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("InquiryEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...INQUIRY_EVENT_NAMES]).toEqual([
      ...EXPECTED_INQUIRY_EVENT_NAMES,
    ]);
  });

  it.each(INQUIRY_EVENT_NAMES)("accepts %s", (name) => {
    expect(inquiryEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => inquiryEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("SafetyEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...SAFETY_EVENT_NAMES]).toEqual([...EXPECTED_SAFETY_EVENT_NAMES]);
  });

  it.each(SAFETY_EVENT_NAMES)("accepts %s", (name) => {
    expect(safetyEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => safetyEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("CarePreparationEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...CARE_PREPARATION_EVENT_NAMES]).toEqual([
      ...EXPECTED_CARE_PREPARATION_EVENT_NAMES,
    ]);
  });

  it.each(CARE_PREPARATION_EVENT_NAMES)("accepts %s", (name) => {
    expect(carePreparationEventNameSchema.parse(name)).toBe(name);
    expect(domainEventNameSchema.parse(name)).toBe(name);
  });

  it("rejects unknown names", () => {
    expect(() => carePreparationEventNameSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("PATIENT_RECORD_DELETED", () => {
  it("is accepted by DomainEventName", () => {
    expect(domainEventNameSchema.parse("PATIENT_RECORD_DELETED")).toBe(
      "PATIENT_RECORD_DELETED",
    );
  });
});

describe("combined DomainEventName", () => {
  it("catalogue equals the exact spec list", () => {
    expect([...DOMAIN_EVENT_NAMES]).toEqual([...EXPECTED_DOMAIN_EVENT_NAMES]);
  });

  it("catalogue contains no duplicates", () => {
    expect(new Set(DOMAIN_EVENT_NAMES).size).toBe(DOMAIN_EVENT_NAMES.length);
  });

  it("accepts every approved event name", () => {
    for (const name of EXPECTED_DOMAIN_EVENT_NAMES) {
      expect(domainEventNameSchema.parse(name)).toBe(name);
    }
  });

  it("rejects unknown names", () => {
    expect(() => domainEventNameSchema.parse("UNKNOWN_EVENT")).toThrow();
    expect(() => domainEventNameSchema.parse("")).toThrow();
  });

  it("rejects dormant event names", () => {
    expect(() =>
      domainEventNameSchema.parse("CARE_SUMMARY_DELIVERED"),
    ).toThrow();
    expect(() =>
      domainEventNameSchema.parse("CARE_SUMMARY_REVIEWED"),
    ).toThrow();
    expect(() =>
      domainEventNameSchema.parse("CLINICIAN_CONFIRMED"),
    ).toThrow();
  });
});

describe("Packet 9B event ownership", () => {
  it("maps every Packet 9B event to one canonical producer and record type", async () => {
    const { PACKET_9B_EVENT_OWNERSHIP, DOMAIN_EVENT_NAMES, COMMAND_NAMES } = await import("./command-event-names");
    for (const name of Object.keys(PACKET_9B_EVENT_OWNERSHIP)) expect(DOMAIN_EVENT_NAMES as readonly string[]).toContain(name);
    expect(Object.values(PACKET_9B_EVENT_OWNERSHIP).map((entry) => `${entry.producedBy}:${entry.recordType}`).sort()).toEqual([
      "CARE_PLAN:APPOINTMENT",
      "CARE_PLAN:APPOINTMENT",
      "CARE_PLAN:PREVENTIVE_CARE_ITEM",
      "CARE_PLAN:PREVENTIVE_CARE_ITEM",
      "HEALTH_RECORDS:CONTEXT_WINDOW",
      "HEALTH_RECORDS:CONTEXT_WINDOW",
      "HEALTH_RECORDS:PREVENTIVE_CARE_RECORD",
      "HEALTH_RECORDS:PREVENTIVE_CARE_RECORD",
    ]);
    for (const command of ["CREATE_PREVENTIVE_CARE_ITEM", "REVISE_PREVENTIVE_CARE_ITEM", "SCHEDULE_APPOINTMENT", "REVISE_APPOINTMENT", "RECORD_PREVENTIVE_CARE_OUTCOME", "RECORD_CONTEXT_WINDOW", "REVISE_CONTEXT_WINDOW", "CORRECT_HEALTH_RECORD"]) {
      expect(COMMAND_NAMES as readonly string[]).toContain(command);
    }
  });

  it("agrees with the owner stores' closed event targets", async () => {
    const { PACKET_9B_EVENT_OWNERSHIP } = await import("./command-event-names");
    const { CARE_ORGANISATION_EVENT_TARGETS } = await import("@/application/care-organisation/care-organisation-persistence");
    for (const [name, entry] of Object.entries(PACKET_9B_EVENT_OWNERSHIP)) {
      if (entry.producedBy === "HEALTH_RECORDS") expect(CARE_ORGANISATION_EVENT_TARGETS[name]).toBe(entry.recordType);
    }
  });
});

describe("Packet 9C event ownership", () => {
  it("maps every canonical care-preparation event to the Care Preparation owner and adds no delivery claim", async () => {
    const { PACKET_9C_EVENT_OWNERSHIP, CARE_PREPARATION_EVENT_NAMES, CARE_PREPARATION_COMMAND_NAMES, DOMAIN_EVENT_NAMES } = await import("./command-event-names");
    expect(Object.keys(PACKET_9C_EVENT_OWNERSHIP)).toEqual([...CARE_PREPARATION_EVENT_NAMES]);
    for (const entry of Object.values(PACKET_9C_EVENT_OWNERSHIP)) expect(entry.producedBy).toBe("CARE_PREPARATION");
    expect(CARE_PREPARATION_COMMAND_NAMES).toEqual([
      "PREPARE_CARE_SUMMARY",
      "MARK_CARE_SUMMARY_PREVIEWED",
      "APPROVE_CARE_SUMMARY",
      "INVALIDATE_CARE_SUMMARY",
      "SUPERSEDE_CARE_SUMMARY",
      "REQUEST_CARE_SUMMARY_EXPORT",
      "COMPLETE_CARE_SUMMARY_EXPORT",
    ]);
    expect((DOMAIN_EVENT_NAMES as readonly string[]).filter((name) => /DELIVERED|(?<!P)REVIEWED|CLINICIAN_CONFIRMED/.test(name))).toEqual([]);
  });
});
