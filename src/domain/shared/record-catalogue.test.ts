import { describe, it, expect } from "vitest";
import {
  recordTypeSchema,
  RECORD_TYPES,
  AuthoritativeOwner,
  AUTHORITATIVE_OWNERS,
  recordOwnerByType,
  getAuthoritativeOwner,
  isOwnedBy,
  DeletionPolicy,
  PrescriptionChangeCandidateState,
  type RecordType,
} from "./record-catalogue";

describe("recordTypeSchema", () => {
  it("accepts every approved record type", () => {
    for (const rt of RECORD_TYPES) {
      expect(recordTypeSchema.parse(rt)).toBe(rt);
    }
  });

  it("rejects an unknown record type", () => {
    expect(() => recordTypeSchema.parse("OBSERVATION")).toThrow();
    expect(() => recordTypeSchema.parse("DOMAIN_RECORD")).toThrow();
    expect(() => recordTypeSchema.parse("UNKNOWN_TYPE")).toThrow();
  });

  // Packet 13 (P13S, Q13-8): + PATIENT_TERMINOLOGY (owner storage decision 2026-10-09).
  // Owner decision 2026-10-14 (My notes): + PERSONAL_NOTE.
  it("has exactly 30 record types", () => {
    expect(RECORD_TYPES).toHaveLength(30);
  });

  it("contains the expected closed set of literals", () => {
    expect(RECORD_TYPES).toEqual(
      expect.arrayContaining([
        "PATIENT_PROFILE",
        "PATIENT_PREFERENCE",
        "CONDITION",
        "PATIENT_TERMINOLOGY",
        "MEDICATION",
        "PRESCRIPTION_VERSION",
        "PRESCRIPTION_CHANGE_CANDIDATE",
        "PREVENTIVE_CARE_ITEM",
        "APPOINTMENT",
        "CARE_QUESTION",
        "REMINDER",
        "GLUCOSE_READING",
        "KETONE_READING",
        "INTAKE_EVENT",
        "SYMPTOM_REPORT",
        "ACTIVITY_EVENT",
        "MEDICATION_EVENT",
        "BODY_MEASUREMENT",
        "PREVENTIVE_CARE_RECORD",
        "CONTEXT_WINDOW",
        "PERSONAL_NOTE",
        "LEARNED_KNOWLEDGE",
        "PATTERN_OBSERVATION",
        "PATTERN_EVIDENCE_SNAPSHOT",
        "INQUIRY",
        "INQUIRY_RESPONSE",
        "SAFETY_EVENT",
        "SAFETY_DELIVERY_ATTEMPT",
        "CARE_SUMMARY_SNAPSHOT",
        "CARE_SUMMARY_EXPORT",
      ]),
    );
  });
});

describe("AuthoritativeOwner", () => {
  it("has exactly eight owners", () => {
    expect(AUTHORITATIVE_OWNERS).toHaveLength(8);
  });

  it("contains the exact owner literals", () => {
    expect(AUTHORITATIVE_OWNERS).toEqual(
      expect.arrayContaining([
        "PATIENT_SETTINGS",
        "CARE_PLAN",
        "HEALTH_RECORDS",
        "LEARNING_ENGINE",
        "PATTERN_ENGINE",
        "INQUIRY",
        "SAFETY_ROUTER",
        "CARE_PREPARATION",
      ]),
    );
  });
});

describe("recordOwnerByType", () => {
  it("has exactly one owner per record type", () => {
    expect(Object.keys(recordOwnerByType).sort()).toEqual(
      [...RECORD_TYPES].sort(),
    );
    for (const rt of RECORD_TYPES) {
      const owner = recordOwnerByType[rt];
      expect(AUTHORITATIVE_OWNERS).toContain(owner);
      expect(owner).toBeDefined();
    }
  });

  it("assigns PATIENT_PROFILE, PATIENT_PREFERENCE, CONDITION to PATIENT_SETTINGS", () => {
    expect(getAuthoritativeOwner("PATIENT_PROFILE")).toBe("PATIENT_SETTINGS");
    expect(getAuthoritativeOwner("PATIENT_PREFERENCE")).toBe("PATIENT_SETTINGS");
    expect(getAuthoritativeOwner("CONDITION")).toBe("PATIENT_SETTINGS");
  });

  it("assigns MEDICATION, PRESCRIPTION_VERSION, PRESCRIPTION_CHANGE_CANDIDATE, PREVENTIVE_CARE_ITEM, APPOINTMENT, CARE_QUESTION, REMINDER to CARE_PLAN", () => {
    expect(getAuthoritativeOwner("MEDICATION")).toBe("CARE_PLAN");
    expect(getAuthoritativeOwner("PRESCRIPTION_VERSION")).toBe("CARE_PLAN");
    expect(getAuthoritativeOwner("PRESCRIPTION_CHANGE_CANDIDATE")).toBe(
      "CARE_PLAN",
    );
    expect(getAuthoritativeOwner("PREVENTIVE_CARE_ITEM")).toBe("CARE_PLAN");
    expect(getAuthoritativeOwner("APPOINTMENT")).toBe("CARE_PLAN");
    expect(getAuthoritativeOwner("CARE_QUESTION")).toBe("CARE_PLAN");
    expect(getAuthoritativeOwner("REMINDER")).toBe("CARE_PLAN");
  });

  it("assigns GLUCOSE_READING through PERSONAL_NOTE to HEALTH_RECORDS", () => {
    const healthRecordTypes: RecordType[] = [
      "GLUCOSE_READING",
      "KETONE_READING",
      "INTAKE_EVENT",
      "SYMPTOM_REPORT",
      "ACTIVITY_EVENT",
      "MEDICATION_EVENT",
      "BODY_MEASUREMENT",
      "PREVENTIVE_CARE_RECORD",
      "CONTEXT_WINDOW",
      "PERSONAL_NOTE",
    ];
    for (const rt of healthRecordTypes) {
      expect(getAuthoritativeOwner(rt)).toBe("HEALTH_RECORDS");
    }
  });

  it("assigns LEARNED_KNOWLEDGE to LEARNING_ENGINE", () => {
    expect(getAuthoritativeOwner("LEARNED_KNOWLEDGE")).toBe("LEARNING_ENGINE");
  });

  it("assigns PATTERN_OBSERVATION, PATTERN_EVIDENCE_SNAPSHOT to PATTERN_ENGINE", () => {
    expect(getAuthoritativeOwner("PATTERN_OBSERVATION")).toBe("PATTERN_ENGINE");
    expect(getAuthoritativeOwner("PATTERN_EVIDENCE_SNAPSHOT")).toBe(
      "PATTERN_ENGINE",
    );
  });

  it("assigns INQUIRY, INQUIRY_RESPONSE to INQUIRY", () => {
    expect(getAuthoritativeOwner("INQUIRY")).toBe("INQUIRY");
    expect(getAuthoritativeOwner("INQUIRY_RESPONSE")).toBe("INQUIRY");
  });

  it("assigns SAFETY_EVENT, SAFETY_DELIVERY_ATTEMPT to SAFETY_ROUTER", () => {
    expect(getAuthoritativeOwner("SAFETY_EVENT")).toBe("SAFETY_ROUTER");
    expect(getAuthoritativeOwner("SAFETY_DELIVERY_ATTEMPT")).toBe(
      "SAFETY_ROUTER",
    );
  });

  it("assigns CARE_SUMMARY_SNAPSHOT, CARE_SUMMARY_EXPORT to CARE_PREPARATION", () => {
    expect(getAuthoritativeOwner("CARE_SUMMARY_SNAPSHOT")).toBe(
      "CARE_PREPARATION",
    );
    expect(getAuthoritativeOwner("CARE_SUMMARY_EXPORT")).toBe(
      "CARE_PREPARATION",
    );
  });
});

describe("isOwnedBy", () => {
  it("returns true when the owner matches", () => {
    expect(isOwnedBy("GLUCOSE_READING", "HEALTH_RECORDS")).toBe(true);
  });

  it("returns false when the owner does not match", () => {
    expect(isOwnedBy("GLUCOSE_READING", "LEARNING_ENGINE")).toBe(false);
  });
});

describe("DeletionPolicy", () => {
  it("contains the exact three policy literals", () => {
    expect(DeletionPolicy).toEqual({
      PATIENT_DELETABLE: "PATIENT_DELETABLE",
      SYSTEM_RETENTION_REQUIRED: "SYSTEM_RETENTION_REQUIRED",
      NOT_APPLICABLE: "NOT_APPLICABLE",
    });
  });
});

describe("PrescriptionChangeCandidateState", () => {
  it("contains the exact five state literals", () => {
    expect(PrescriptionChangeCandidateState).toEqual(
      expect.arrayContaining([
        "PENDING_RECONCILIATION",
        "RECONCILED_WITH_VERIFIED_SOURCE",
        "CONFLICTING_SOURCE",
        "DISMISSED",
        "SUPERSEDED",
      ]),
    );
    expect(PrescriptionChangeCandidateState).toHaveLength(5);
  });
});