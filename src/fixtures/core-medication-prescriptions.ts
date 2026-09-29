import {
  medicationPayloadSchema,
  type MedicationPayload,
} from "../domain/care-plan/medication";
import {
  type PrescriptionVersionPayload,
  prescriptionVersionPayloadSchema,
} from "../domain/care-plan/prescription-version";

// --- Section 6.10: Readonly synthetic fixture catalogue ---

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

const insulinPenMedication = medicationPayloadSchema.parse({
  identity: {
    kind: "REVIEWED_CATALOGUE_MATCH",
    patientEnteredName: "Insulin",
    catalogueEntryKey: "insulin-rapid-action",
    catalogueVersion: "2.0",
    matchedLabel: "Insulin (rapid-acting)",
    matchMethod: "STRUCTURED_PATIENT_SELECTION",
  },
  doseForm: "INJECTION_SOLUTION",
  route: "SUBCUTANEOUS",
  deliveryDevice: "INSULIN_PEN",
}) satisfies MedicationPayload;

const unmappedMedication = medicationPayloadSchema.parse({
  identity: {
    kind: "UNMAPPED",
    patientEnteredName: "My herbal supplement",
  },
  doseForm: "OTHER",
  route: "ORAL",
  deliveryDevice: "NONE",
}) satisfies MedicationPayload;

const fixedDoseInsulin = prescriptionVersionPayloadSchema.parse({
  medication: {
    recordType: "MEDICATION",
    recordId: UUID,
    revisionId: UUID,
  },
  sourceInstructionText: {
    text: "Take 10 units before breakfast",
    language: "en-SG",
  },
  doseInstruction: {
    kind: "FIXED",
    amount: { value: "10", unit: "UNIT" },
  },
  schedule: {
    kind: "FIXED_LOCAL_TIMES",
    entries: [{ scheduleKey: "morning", time: "08:00" }],
  },
  effectivePeriod: {
    start: { kind: "UNKNOWN" },
    end: { kind: "OPEN" },
  },
}) satisfies PrescriptionVersionPayload;

const variableDoseInsulin = prescriptionVersionPayloadSchema.parse({
  medication: {
    recordType: "MEDICATION",
    recordId: UUID,
    revisionId: UUID,
  },
  sourceInstructionText: {
    text: "8 or 12 units: 12 if pre-meal glucose above 10",
    language: "en-SG",
  },
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
  schedule: {
    kind: "FIXED_LOCAL_TIMES",
    entries: [{ scheduleKey: "morning", time: "08:00" }],
  },
  effectivePeriod: {
    start: { kind: "UNKNOWN" },
    end: { kind: "UNKNOWN" },
  },
}) satisfies PrescriptionVersionPayload;

const unstructuredPrescription = prescriptionVersionPayloadSchema.parse({
  medication: {
    recordType: "MEDICATION",
    recordId: UUID,
    revisionId: UUID,
  },
  sourceInstructionText: {
    text: "Use as directed by my doctor",
    language: "en-SG",
  },
  doseInstruction: {
    kind: "UNSTRUCTURED",
  },
  schedule: {
    kind: "UNSTRUCTURED",
  },
  effectivePeriod: {
    start: { kind: "UNKNOWN" },
    end: { kind: "UNKNOWN" },
  },
}) satisfies PrescriptionVersionPayload;

export const coreMedicationPrescriptions = Object.freeze({
  insulinPenMedication,
  unmappedMedication,
  fixedDoseInsulin,
  variableDoseInsulin,
  unstructuredPrescription,
});