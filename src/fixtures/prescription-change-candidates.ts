import {
  prescriptionChangeCandidatePayloadSchema,
  type PrescriptionChangeCandidatePayload,
} from "../domain/care-plan/prescription-change-candidate";

// --- Section 6.10: Readonly synthetic fixture catalogue ---

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

// A pending patient-reported timing change with unknown effective time.
const pendingTimingChange = prescriptionChangeCandidatePayloadSchema.parse({
  medication: MEDICATION_REF,
  changeKinds: ["TIMING_CHANGED"],
  reportedNewInstructionText: {
    text: "Doctor said take it at 9pm instead",
    language: "en-SG",
  },
  reportedEffectiveFrom: { kind: "UNKNOWN" },
  reconciliation: { state: "PENDING_RECONCILIATION" },
}) satisfies PrescriptionChangeCandidatePayload;

// A pending dose-change report with a structured candidate.
const pendingDoseChangeWithCandidate =
  prescriptionChangeCandidatePayloadSchema.parse({
    medication: MEDICATION_REF,
    changeKinds: ["DOSE_CHANGED"],
    reportedNewInstructionText: {
      text: "Doctor increased my dose to 12 units",
      language: "en-SG",
    },
    structuredCandidate: {
      doseInstruction: {
        kind: "FIXED",
        amount: { value: "12", unit: "UNIT" },
      },
      schedule: {
        kind: "FIXED_LOCAL_TIMES",
        entries: [{ scheduleKey: "morning", time: "08:00" }],
      },
    },
    comparedWith: PRESCRIPTION_VERSION_REF,
    reconciliation: { state: "PENDING_RECONCILIATION" },
  }) satisfies PrescriptionChangeCandidatePayload;

// A reconciled candidate referencing a verified prescription.
const reconciledWithVerifiedSource =
  prescriptionChangeCandidatePayloadSchema.parse({
    medication: MEDICATION_REF,
    changeKinds: ["TIMING_CHANGED"],
    reportedNewInstructionText: {
      text: "Doctor said take it at 9pm instead",
      language: "en-SG",
    },
    comparedWith: PRESCRIPTION_VERSION_REF,
    reconciliation: {
      state: "RECONCILED_WITH_VERIFIED_SOURCE",
      verifiedPrescription: PRESCRIPTION_VERSION_REF,
    },
  }) satisfies PrescriptionChangeCandidatePayload;

// A conflicting-source candidate.
const conflictingSource = prescriptionChangeCandidatePayloadSchema.parse({
  medication: MEDICATION_REF,
  changeKinds: ["DOSE_CHANGED"],
  reportedNewInstructionText: {
    text: "Doctor said 15 units but the app still shows 10",
    language: "en-SG",
  },
  comparedWith: PRESCRIPTION_VERSION_REF,
  reconciliation: {
    state: "CONFLICTING_SOURCE",
    conflictingPrescription: PRESCRIPTION_VERSION_REF,
  },
}) satisfies PrescriptionChangeCandidatePayload;

// A superseded candidate.
const superseded = prescriptionChangeCandidatePayloadSchema.parse({
  medication: MEDICATION_REF,
  changeKinds: ["TIMING_CHANGED"],
  reportedNewInstructionText: {
    text: "Doctor said take it at 9pm instead",
    language: "en-SG",
  },
  reconciliation: {
    state: "SUPERSEDED",
    successor: CHANGE_CANDIDATE_REF,
  },
}) satisfies PrescriptionChangeCandidatePayload;

export const prescriptionChangeCandidates = Object.freeze({
  pendingTimingChange,
  pendingDoseChangeWithCandidate,
  reconciledWithVerifiedSource,
  conflictingSource,
  superseded,
});