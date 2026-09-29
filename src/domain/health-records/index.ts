// Public barrel for health-records domain modules.

export {
  patientAuthoredNoteSchema,
  type PatientAuthoredNote,
} from "./patient-authored-note";

export {
  decimalStringSchema,
  createMeasurementValueSchema,
  type DecimalString,
  type MeasurementValue,
} from "./measurement";

export {
  dataValidityOutcomeSchema,
  dataValidityAssessmentOutcomeSchema,
  createDataValidityAssessmentSchema,
  type DataValidityOutcome,
  type DataValidityAssessment,
} from "./data-validity-assessment";

export {
  bodyMeasurementPayloadSchema,
  bodyMeasurementTemporalSchema,
  BODY_MEASUREMENT_DELETION_POLICY,
  type BodyMeasurementPayload,
  type BodyMeasurementTemporal,
} from "./body-measurement";

// Packet 2C: reading temporal
export {
  readingTemporalSchema,
  type ReadingTemporal,
} from "./reading-temporal";

// Packet 2C: glucose reading
export {
  glucoseReadingPayloadSchema,
  glucoseMeasurementContextSchema,
  glucoseMeasurementMethodSchema,
  DEFAULT_GLUCOSE_ENTRY_UNIT,
  GLUCOSE_READING_DELETION_POLICY,
  GLUCOSE_READING_REVISION_ACTIONS,
  type GlucoseReadingPayload,
  type GlucoseMeasurementContext,
  type GlucoseMeasurementMethod,
} from "./glucose-reading";

// Packet 2C: ketone reading
export {
  ketoneReadingPayloadSchema,
  urineKetoneResultSchema,
  bloodKetoneMeasurementMethodSchema,
  urineKetoneMeasurementMethodSchema,
  KETONE_READING_DELETION_POLICY,
  KETONE_READING_REVISION_ACTIONS,
  type KetoneReadingPayload,
  type UrineKetoneResult,
  type BloodKetoneMeasurementMethod,
  type UrineKetoneMeasurementMethod,
} from "./ketone-reading";

// Packet 3A: observation temporal
export {
  intakeTemporalSchema,
  symptomTemporalSchema,
  activityTemporalSchema,
  type IntakeTemporal,
  type SymptomTemporal,
  type ActivityTemporal,
} from "./observation-temporal";

// Packet 3A: intake event
export {
  intakeEventPayloadSchema,
  intakeKindSchema,
  intakeSlotSchema,
  intakeItemSchema,
  intakeReasonSchema,
  patientDefinedIntakeSlotKeySchema,
  INTAKE_EVENT_DELETION_POLICY,
  INTAKE_EVENT_REVISION_ACTIONS,
  type IntakeEventPayload,
  type IntakeKind,
  type IntakeSlot,
  type IntakeItem,
  type IntakeReason,
  type PatientDefinedIntakeSlotKey,
} from "./intake-event";

// Packet 3A: symptom report
export {
  symptomReportPayloadSchema,
  symptomCodeSchema,
  symptomEntrySchema,
  safetyCapabilitySnapshotSchema,
  capabilityStateSchema,
  SYMPTOM_REPORT_DELETION_POLICY,
  SYMPTOM_REPORT_REVISION_ACTIONS,
  type SymptomReportPayload,
  type SymptomEntry,
  type SymptomCode,
  type SafetyCapabilitySnapshot,
  type CapabilityState,
} from "./symptom-report";

// Packet 3A: activity event
export {
  activityEventPayloadSchema,
  activityCategorySchema,
  activityReportedIntensitySchema,
  reportedDurationMinutesSchema,
  ACTIVITY_EVENT_DELETION_POLICY,
  ACTIVITY_EVENT_REVISION_ACTIONS,
  type ActivityEventPayload,
  type ActivityCategory,
  type ActivityReportedIntensity,
} from "./activity-event";