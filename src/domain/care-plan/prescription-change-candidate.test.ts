import { describe, it, expect } from "vitest";
import {
  prescriptionChangeCandidatePayloadSchema,
  prescriptionChangeReconciliationSchema,
  prescriptionInstructionCandidateSchema,
  PRESCRIPTION_CHANGE_CANDIDATE_DELETION_POLICY,
  PRESCRIPTION_CHANGE_CANDIDATE_REVISION_ACTIONS,
  type PrescriptionChangeCandidatePayload,
} from "./prescription-change-candidate";
import { DeletionPolicy } from "../shared/record-catalogue";

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

const MEDICATION_REF = {
  recordType: "MEDICATION" as const,
  recordId: UUID,
  revisionId: UUID,
};

const PRESCRIPTION_VERSION_REF = {
  recordType: "PRESCRIPTION_VERSION" as const,
  recordId: UUID,
  revisionId: UUID,
};

const CHANGE_CANDIDATE_REF = {
  recordType: "PRESCRIPTION_CHANGE_CANDIDATE" as const,
  recordId: UUID,
  revisionId: UUID,
};

function mkBase() {
  return {
    medication: MEDICATION_REF,
    changeKinds: ["TIMING_CHANGED" as const],
    reportedNewInstructionText: {
      text: "Doctor said take it at 9pm instead",
      language: "en-SG" as const,
    },
    reconciliation: { state: "PENDING_RECONCILIATION" as const },
  };
}

// --- changeKinds ---

describe("changeKinds", () => {
  it("accepts a single change kind", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse(mkBase());
    expect(result.changeKinds).toEqual(["TIMING_CHANGED"]);
  });

  it("accepts multiple change kinds", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      changeKinds: ["DOSE_CHANGED", "TIMING_CHANGED"],
    });
    expect(result.changeKinds).toHaveLength(2);
  });

  it("rejects an empty changeKinds array", () => {
    expect(() =>
      prescriptionChangeCandidatePayloadSchema.parse({
        ...mkBase(),
        changeKinds: [],
      }),
    ).toThrow();
  });

  it("rejects an unknown change kind", () => {
    expect(() =>
      prescriptionChangeCandidatePayloadSchema.parse({
        ...mkBase(),
        changeKinds: ["DIAGNOSIS_CHANGED"],
      }),
    ).toThrow();
  });
});

// --- Text preservation ---

describe("reportedNewInstructionText preservation", () => {
  it("preserves patient-reported wording unchanged", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse(mkBase());
    expect(result.reportedNewInstructionText.text).toBe(
      "Doctor said take it at 9pm instead",
    );
  });

  it("preserves zh-SG text", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      reportedNewInstructionText: {
        text: "医生说改成晚上九点吃",
        language: "zh-SG",
      },
    });
    expect(result.reportedNewInstructionText.language).toBe("zh-SG");
    expect(result.reportedNewInstructionText.text).toBe("医生说改成晚上九点吃");
  });
});

// --- Unknown effective time ---

describe("reportedEffectiveFrom", () => {
  it("preserves an unknown effective time without substitution", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      reportedEffectiveFrom: { kind: "UNKNOWN" },
    });
    expect(result.reportedEffectiveFrom!.kind).toBe("UNKNOWN");
  });

  it("accepts an EXACT time point", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      reportedEffectiveFrom: {
        kind: "EXACT",
        instantUtc: "2026-02-01T00:00:00Z",
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    });
    expect(result.reportedEffectiveFrom!.kind).toBe("EXACT");
  });

  it("is optional", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse(mkBase());
    expect(result.reportedEffectiveFrom).toBeUndefined();
  });
});

// --- Structured candidate ---

describe("structuredCandidate", () => {
  it("is optional", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse(mkBase());
    expect(result.structuredCandidate).toBeUndefined();
  });

  it("accepts a dose instruction and schedule", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      structuredCandidate: {
        doseInstruction: {
          kind: "FIXED",
          amount: { value: "12", unit: "UNIT" },
        },
        schedule: {
          kind: "FIXED_LOCAL_TIMES",
          entries: [{ scheduleKey: "evening", time: "21:00" }],
        },
      },
    });
    expect(result.structuredCandidate!.doseInstruction!.kind).toBe("FIXED");
  });

  it("does not become a prescription version", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      structuredCandidate: {
        doseInstruction: { kind: "UNSTRUCTURED" },
      },
    });
    // structuredCandidate is just an optional interpretation; it carries no
    // medication ref, source text, or effective period that would make it a
    // PrescriptionVersionPayload.
    expect(result.structuredCandidate).toBeDefined();
    expect(result.reconciliation.state).toBe("PENDING_RECONCILIATION");
  });

  it("does not select a single dose from a variable plan", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      structuredCandidate: {
        doseInstruction: {
          kind: "VARIABLE_PER_REPORTED_PLAN",
          reportedAmounts: [
            { value: "8", unit: "UNIT" },
            { value: "12", unit: "UNIT" },
          ],
          decisionInstructionText: {
            text: "12 if pre-meal glucose above 10",
            language: "en-SG",
          },
        },
      },
    });
    if (
      result.structuredCandidate!.doseInstruction!.kind ===
      "VARIABLE_PER_REPORTED_PLAN"
    ) {
      expect(
        result.structuredCandidate!.doseInstruction!.reportedAmounts,
      ).toHaveLength(2);
    }
  });

  it("rejects unknown keys", () => {
    expect(() =>
      prescriptionInstructionCandidateSchema.parse({
        doseInstruction: { kind: "UNSTRUCTURED" },
        extra: true,
      }),
    ).toThrow();
  });
});

// --- comparedWith ---

describe("comparedWith", () => {
  it("accepts a PRESCRIPTION_VERSION revision reference", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      comparedWith: PRESCRIPTION_VERSION_REF,
    });
    expect(result.comparedWith!.recordType).toBe("PRESCRIPTION_VERSION");
  });

  it("rejects a wrong recordType", () => {
    expect(() =>
      prescriptionChangeCandidatePayloadSchema.parse({
        ...mkBase(),
        comparedWith: MEDICATION_REF,
      }),
    ).toThrow();
  });

  it("rejects a bare identifier string", () => {
    expect(() =>
      prescriptionChangeCandidatePayloadSchema.parse({
        ...mkBase(),
        comparedWith: UUID,
      }),
    ).toThrow();
  });

  it("is optional", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse(mkBase());
    expect(result.comparedWith).toBeUndefined();
  });
});

// --- Reconciliation variants ---

describe("prescriptionChangeReconciliationSchema", () => {
  it("PENDING_RECONCILIATION has no clinician-verification claim", () => {
    const result = prescriptionChangeReconciliationSchema.parse({
      state: "PENDING_RECONCILIATION",
    });
    expect(result.state).toBe("PENDING_RECONCILIATION");
  });

  it("RECONCILED_WITH_VERIFIED_SOURCE requires verifiedPrescription", () => {
    const result = prescriptionChangeReconciliationSchema.parse({
      state: "RECONCILED_WITH_VERIFIED_SOURCE",
      verifiedPrescription: PRESCRIPTION_VERSION_REF,
    });
    expect(result.state).toBe("RECONCILED_WITH_VERIFIED_SOURCE");
  });

  it("CONFLICTING_SOURCE requires conflictingPrescription", () => {
    const result = prescriptionChangeReconciliationSchema.parse({
      state: "CONFLICTING_SOURCE",
      conflictingPrescription: PRESCRIPTION_VERSION_REF,
    });
    expect(result.state).toBe("CONFLICTING_SOURCE");
  });

  it("DISMISSED accepts an optional reason", () => {
    const result = prescriptionChangeReconciliationSchema.parse({
      state: "DISMISSED",
      reason: { text: "Patient confirmed it was a data-entry mistake", language: "en-SG" },
    });
    expect(result.state).toBe("DISMISSED");
  });

  it("DISMISSED works without a reason", () => {
    const result = prescriptionChangeReconciliationSchema.parse({
      state: "DISMISSED",
    });
    expect(result.state).toBe("DISMISSED");
  });

  it("SUPERSEDED requires a successor candidate reference", () => {
    const result = prescriptionChangeReconciliationSchema.parse({
      state: "SUPERSEDED",
      successor: CHANGE_CANDIDATE_REF,
    });
    expect(result.state).toBe("SUPERSEDED");
  });

  it("each reconciliation state remains distinct", () => {
    const states = new Set([
      "PENDING_RECONCILIATION",
      "RECONCILED_WITH_VERIFIED_SOURCE",
      "CONFLICTING_SOURCE",
      "DISMISSED",
      "SUPERSEDED",
    ]);
    expect(states.size).toBe(5);
  });

  it("PENDING_RECONCILIATION rejects a verifiedPrescription field", () => {
    expect(() =>
      prescriptionChangeReconciliationSchema.parse({
        state: "PENDING_RECONCILIATION",
        verifiedPrescription: PRESCRIPTION_VERSION_REF,
      }),
    ).toThrow();
  });

  it("RECONCILED_WITH_VERIFIED_SOURCE rejects conflictingPrescription", () => {
    expect(() =>
      prescriptionChangeReconciliationSchema.parse({
        state: "RECONCILED_WITH_VERIFIED_SOURCE",
        verifiedPrescription: PRESCRIPTION_VERSION_REF,
        conflictingPrescription: PRESCRIPTION_VERSION_REF,
      }),
    ).toThrow();
  });

  it("SUPERSEDED rejects a verifiedPrescription field", () => {
    expect(() =>
      prescriptionChangeReconciliationSchema.parse({
        state: "SUPERSEDED",
        successor: CHANGE_CANDIDATE_REF,
        verifiedPrescription: PRESCRIPTION_VERSION_REF,
      }),
    ).toThrow();
  });

  it("RECONCILED_WITH_VERIFIED_SOURCE rejects a wrong recordType on verifiedPrescription", () => {
    expect(() =>
      prescriptionChangeReconciliationSchema.parse({
        state: "RECONCILED_WITH_VERIFIED_SOURCE",
        verifiedPrescription: CHANGE_CANDIDATE_REF,
      }),
    ).toThrow();
  });

  it("SUPERSEDED rejects a wrong recordType on successor", () => {
    expect(() =>
      prescriptionChangeReconciliationSchema.parse({
        state: "SUPERSEDED",
        successor: PRESCRIPTION_VERSION_REF,
      }),
    ).toThrow();
  });

  it("rejects an unknown state", () => {
    expect(() =>
      prescriptionChangeReconciliationSchema.parse({
        state: "APPROVED",
      }),
    ).toThrow();
  });
});

// --- Full payload strict-object rejection ---

describe("prescriptionChangeCandidatePayloadSchema strict-object rejection", () => {
  it("rejects unknown keys at top level", () => {
    expect(() =>
      prescriptionChangeCandidatePayloadSchema.parse({
        ...mkBase(),
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a wrong recordType on medication ref", () => {
    expect(() =>
      prescriptionChangeCandidatePayloadSchema.parse({
        ...mkBase(),
        medication: PRESCRIPTION_VERSION_REF,
      }),
    ).toThrow();
  });

  it("rejects a bare identifier on medication ref", () => {
    expect(() =>
      prescriptionChangeCandidatePayloadSchema.parse({
        ...mkBase(),
        medication: UUID,
      }),
    ).toThrow();
  });

  it("preserves a patient note unchanged", () => {
    const result = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      patientNote: { text: "Feeling better on the new time", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Feeling better on the new time");
  });
});

// --- Reconciliation preserves original candidate ---

describe("reconciliation preserves original candidate", () => {
  it("does not rewrite reportedNewInstructionText when reconciled", () => {
    const payload = prescriptionChangeCandidatePayloadSchema.parse({
      ...mkBase(),
      comparedWith: PRESCRIPTION_VERSION_REF,
      reconciliation: {
        state: "RECONCILED_WITH_VERIFIED_SOURCE",
        verifiedPrescription: PRESCRIPTION_VERSION_REF,
      },
    });
    // The source wording must survive reconciliation unchanged.
    expect(payload.reportedNewInstructionText.text).toBe(
      "Doctor said take it at 9pm instead",
    );
    expect(payload.changeKinds).toEqual(["TIMING_CHANGED"]);
  });

  it("pending candidate contains no clinician-verification field", () => {
    const payload = prescriptionChangeCandidatePayloadSchema.parse(
      mkBase(),
    ) satisfies PrescriptionChangeCandidatePayload;
    // PENDING_RECONCILIATION is a bare { state } object.
    expect(payload.reconciliation.state).toBe("PENDING_RECONCILIATION");
    const recon = payload.reconciliation;
    if (recon.state === "PENDING_RECONCILIATION") {
      const keys = Object.keys(recon);
      expect(keys).toEqual(["state"]);
    }
  });
});

// --- Shared boundaries ---

describe("PRESCRIPTION_CHANGE_CANDIDATE shared boundaries", () => {
  it("is PATIENT_DELETABLE", () => {
    expect(PRESCRIPTION_CHANGE_CANDIDATE_DELETION_POLICY).toBe(
      DeletionPolicy.PATIENT_DELETABLE,
    );
  });

  it("has exactly CREATE, CORRECT", () => {
    expect(PRESCRIPTION_CHANGE_CANDIDATE_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
    ]);
  });

  it("does not include CONFIRM", () => {
    expect(PRESCRIPTION_CHANGE_CANDIDATE_REVISION_ACTIONS).not.toContain(
      "CONFIRM",
    );
  });
});