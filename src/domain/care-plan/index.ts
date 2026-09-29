// Public barrel for care-plan domain modules.

// Section 6.2: medication identity
export {
  medicationPayloadSchema,
  medicationIdentitySchema,
  medicationDoseFormSchema,
  medicationRouteSchema,
  medicationDeliveryDeviceSchema,
  MEDICATION_DELETION_POLICY,
  MEDICATION_REVISION_ACTIONS,
  type MedicationPayload,
  type MedicationIdentity,
  type MedicationDoseForm,
  type MedicationRoute,
  type MedicationDeliveryDevice,
} from "./medication";

// Section 6.3–6.4: dose and instruction text
export {
  doseAmountSchema,
  prescriptionInstructionTextSchema,
  type DoseAmount,
  type DoseUnit,
  type PrescriptionInstructionText,
} from "./dose";

// Section 6.5: prescription schedule
export {
  localClockTimeSchema,
  prescriptionTimingAllowanceSchema,
  prescriptionScheduleSchema,
  eventRelativeMedicationTimingSchema,
  type LocalClockTime,
  type PrescriptionTimingAllowance,
  type FixedLocalTimeScheduleEntry,
  type EventRelativeMedicationTiming,
  type PrescriptionSchedule,
} from "./prescription-schedule";

// Section 6.4: prescription version
export {
  prescriptionVersionPayloadSchema,
  prescriptionEffectivePeriodSchema,
  prescriptionDoseInstructionSchema,
  PRESCRIPTION_VERSION_DELETION_POLICY,
  PRESCRIPTION_VERSION_REVISION_ACTIONS,
  type PrescriptionVersionPayload,
  type PrescriptionEffectivePeriod,
  type PrescriptionDoseInstruction,
} from "./prescription-version";

// Section 6.6: patient-reported prescription changes
export {
  prescriptionChangeKindSchema,
  prescriptionInstructionCandidateSchema,
  prescriptionChangeReconciliationSchema,
  prescriptionChangeCandidatePayloadSchema,
  PRESCRIPTION_CHANGE_CANDIDATE_DELETION_POLICY,
  PRESCRIPTION_CHANGE_CANDIDATE_REVISION_ACTIONS,
  type PrescriptionChangeKind,
  type PrescriptionInstructionCandidate,
  type PrescriptionChangeReconciliation,
  type PrescriptionChangeCandidatePayload,
} from "./prescription-change-candidate";
