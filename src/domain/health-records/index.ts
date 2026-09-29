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