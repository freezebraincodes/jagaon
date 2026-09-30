import {
  medicationEventPayloadSchema,
  type MedicationEventPayload,
} from "../domain/health-records";

// Section 6.10: readonly synthetic medication-event fixtures.

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

const medication = {
  recordType: "MEDICATION" as const,
  recordId: UUID,
  revisionId: UUID,
};

const prescriptionVersion = {
  recordType: "PRESCRIPTION_VERSION" as const,
  recordId: UUID,
  revisionId: UUID,
};

const delayedEvent = {
  recordType: "MEDICATION_EVENT" as const,
  recordId: UUID,
  revisionId: UUID,
};

const intendedOccasion = {
  expectedAt: {
    kind: "EXACT" as const,
    instantUtc: "2026-01-15T00:00:00Z",
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
  prescriptionVersion,
  scheduleKey: "morning",
};

const base = { medication };

const explicitlyMissedDose = medicationEventPayloadSchema.parse({
  ...base,
  state: "MISSED",
  intendedOccasion,
}) satisfies MedicationEventPayload;

const unsureWhetherTaken = medicationEventPayloadSchema.parse({
  ...base,
  state: "UNSURE",
  intendedOccasion,
}) satisfies MedicationEventPayload;

const declinedToRecord = medicationEventPayloadSchema.parse({
  ...base,
  state: "DECLINED_TO_RECORD",
  intendedOccasion,
}) satisfies MedicationEventPayload;

const takenAmountNotRecorded = medicationEventPayloadSchema.parse({
  ...base,
  state: "TAKEN",
  amountTaken: { kind: "NOT_RECORDED" },
}) satisfies MedicationEventPayload;

const delayedDose = medicationEventPayloadSchema.parse({
  ...base,
  state: "DELAYED",
  intendedOccasion,
}) satisfies MedicationEventPayload;

const takenAfterDelay = medicationEventPayloadSchema.parse({
  ...base,
  state: "TAKEN",
  amountTaken: {
    kind: "KNOWN",
    amount: { value: "5", unit: "UNIT" },
  },
  resolvesDelayedEvent: delayedEvent,
}) satisfies MedicationEventPayload;

const allSafetyConcerns = medicationEventPayloadSchema.parse({
  ...base,
  state: "TAKEN",
  amountTaken: { kind: "UNSURE" },
  reportedSafetyConcerns: [
    "POSSIBLE_EXTRA_DOSE",
    "POSSIBLE_DOUBLE_DOSE",
    "POSSIBLE_WRONG_MEDICATION",
    "POSSIBLE_WRONG_AMOUNT",
    "DEVICE_OR_DELIVERY_ISSUE",
  ],
}) satisfies MedicationEventPayload;

const unmatchedPrescriptionTaken = medicationEventPayloadSchema.parse({
  ...base,
  state: "TAKEN",
  amountTaken: { kind: "NOT_RECORDED" },
}) satisfies MedicationEventPayload;

export const coreMedicationEvents = Object.freeze({
  explicitlyMissedDose,
  unsureWhetherTaken,
  declinedToRecord,
  takenAmountNotRecorded,
  delayedDose,
  takenAfterDelay,
  allSafetyConcerns,
  unmatchedPrescriptionTaken,
});
