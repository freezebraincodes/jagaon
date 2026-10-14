import { z } from "zod";

// ===========================================================================
// Command name catalogues (Sections 6.2–6.5, 7.1–7.4)
// ===========================================================================

// --- Section 6.2: Patient Settings commands --------------------------------

export const PATIENT_SETTINGS_COMMAND_NAMES = [
  "CREATE_PATIENT_PROFILE",
  "REVISE_PATIENT_PROFILE",
  "SET_PATIENT_PREFERENCE",
  "CORRECT_PATIENT_PREFERENCE",
  "RECORD_CONDITION",
  "REVISE_CONDITION",
  // Packet 13 (P13S): explicit "remember" and "change" of a patient-confirmed term ("forget" is DELETE_PATIENT_RECORD).
  "REMEMBER_PATIENT_TERM",
  "CHANGE_PATIENT_TERM",
] as const;

export type PatientSettingsCommandName =
  (typeof PATIENT_SETTINGS_COMMAND_NAMES)[number];

export const patientSettingsCommandNameSchema = z.enum(
  PATIENT_SETTINGS_COMMAND_NAMES,
);

// --- Section 6.3: Care Plan commands ---------------------------------------

export const CARE_PLAN_COMMAND_NAMES = [
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

export type CarePlanCommandName = (typeof CARE_PLAN_COMMAND_NAMES)[number];

export const carePlanCommandNameSchema = z.enum(CARE_PLAN_COMMAND_NAMES);

// --- Section 6.4: Health Records commands ----------------------------------

export const HEALTH_RECORD_COMMAND_NAMES = [
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
  // Owner decision 2026-10-14: an explicit save of one personal note ("delete" is DELETE_PATIENT_RECORD).
  "RECORD_PERSONAL_NOTE",
] as const;

export type HealthRecordCommandName =
  (typeof HEALTH_RECORD_COMMAND_NAMES)[number];

export const healthRecordCommandNameSchema = z.enum(HEALTH_RECORD_COMMAND_NAMES);

// --- Section 6.5: Patient Control commands ---------------------------------

export const PATIENT_CONTROL_COMMAND_NAMES = [
  "DELETE_PATIENT_RECORD",
] as const;

export type PatientControlCommandName =
  (typeof PATIENT_CONTROL_COMMAND_NAMES)[number];

export const patientControlCommandNameSchema = z.enum(
  PATIENT_CONTROL_COMMAND_NAMES,
);

// --- Section 7.1: Learning and Pattern commands ----------------------------

export const LEARNING_PATTERN_COMMAND_NAMES = [
  "REEVALUATE_LEARNING",
  "CONFIRM_LEARNED_KNOWLEDGE",
  "REJECT_LEARNED_KNOWLEDGE",
  "RETIRE_LEARNED_KNOWLEDGE",
  "REEVALUATE_PATTERN_FAMILY",
  "TRANSITION_PATTERN_OBSERVATION",
] as const;

export type LearningPatternCommandName =
  (typeof LEARNING_PATTERN_COMMAND_NAMES)[number];

export const learningPatternCommandNameSchema = z.enum(
  LEARNING_PATTERN_COMMAND_NAMES,
);

// --- Section 7.2: Inquiry commands -----------------------------------------

export const INQUIRY_COMMAND_NAMES = [
  "CREATE_INQUIRY_CANDIDATE",
  "TRANSITION_INQUIRY",
  "ANSWER_INQUIRY",
  "CORRECT_INQUIRY_RESPONSE",
  "PROCESS_INQUIRY_RESPONSE",
] as const;

export type InquiryCommandName = (typeof INQUIRY_COMMAND_NAMES)[number];

export const inquiryCommandNameSchema = z.enum(INQUIRY_COMMAND_NAMES);

// --- Section 7.3: Safety Router commands -----------------------------------

export const SAFETY_COMMAND_NAMES = [
  "RECORD_SAFETY_DELIVERY_ATTEMPT",
  "TRANSITION_SAFETY_DELIVERY_ATTEMPT",
  "ACKNOWLEDGE_SAFETY_PRESENTATION",
  "LINK_SAFETY_RELATED_ACTION",
  "LINK_SAFETY_RECHECK",
  "REEVALUATE_SAFETY_EVENT",
] as const;

export type SafetyCommandName = (typeof SAFETY_COMMAND_NAMES)[number];

export const safetyCommandNameSchema = z.enum(SAFETY_COMMAND_NAMES);

// --- Section 7.4: Care Preparation commands --------------------------------

export const CARE_PREPARATION_COMMAND_NAMES = [
  "PREPARE_CARE_SUMMARY",
  "MARK_CARE_SUMMARY_PREVIEWED",
  "APPROVE_CARE_SUMMARY",
  "INVALIDATE_CARE_SUMMARY",
  "SUPERSEDE_CARE_SUMMARY",
  "REQUEST_CARE_SUMMARY_EXPORT",
  "COMPLETE_CARE_SUMMARY_EXPORT",
] as const;

export type CarePreparationCommandName =
  (typeof CARE_PREPARATION_COMMAND_NAMES)[number];

export const carePreparationCommandNameSchema = z.enum(
  CARE_PREPARATION_COMMAND_NAMES,
);

// --- Combined CommandName union (Section 5.1) ------------------------------

export const COMMAND_NAMES = [
  ...PATIENT_SETTINGS_COMMAND_NAMES,
  ...CARE_PLAN_COMMAND_NAMES,
  ...HEALTH_RECORD_COMMAND_NAMES,
  ...PATIENT_CONTROL_COMMAND_NAMES,
  ...LEARNING_PATTERN_COMMAND_NAMES,
  ...INQUIRY_COMMAND_NAMES,
  ...SAFETY_COMMAND_NAMES,
  ...CARE_PREPARATION_COMMAND_NAMES,
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export const commandNameSchema = z.enum(COMMAND_NAMES);

// ===========================================================================
// Event name catalogues (Sections 8.1–8.4, 9.1–9.4)
// ===========================================================================

// --- Section 8.1: Patient Settings events ----------------------------------

export const PATIENT_SETTINGS_EVENT_NAMES = [
  "PATIENT_PROFILE_CREATED",
  "PATIENT_PROFILE_REVISED",
  "PATIENT_PREFERENCE_SET",
  "PATIENT_PREFERENCE_CORRECTED",
  "CONDITION_RECORDED",
  "CONDITION_REVISED",
  // Packet 13 (P13S): no consumer; the payload is a closed reason only (never the phrase).
  "PATIENT_TERM_REMEMBERED",
  "PATIENT_TERM_CHANGED",
] as const;

export type PatientSettingsEventName =
  (typeof PATIENT_SETTINGS_EVENT_NAMES)[number];

export const patientSettingsEventNameSchema = z.enum(
  PATIENT_SETTINGS_EVENT_NAMES,
);

// --- Section 8.2: Care Plan events -----------------------------------------

export const CARE_PLAN_EVENT_NAMES = [
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

export type CarePlanEventName = (typeof CARE_PLAN_EVENT_NAMES)[number];

export const carePlanEventNameSchema = z.enum(CARE_PLAN_EVENT_NAMES);

// --- Section 8.3: Health Records events ------------------------------------

export const HEALTH_RECORD_EVENT_NAMES = [
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
  // Owner decision 2026-10-14: no consumer; the payload is a closed reason only (never the note).
  "PERSONAL_NOTE_RECORDED",
] as const;

export type HealthRecordEventName =
  (typeof HEALTH_RECORD_EVENT_NAMES)[number];

export const healthRecordEventNameSchema = z.enum(HEALTH_RECORD_EVENT_NAMES);

// --- Section 9.1: Learning and Pattern events ------------------------------

export const LEARNING_EVENT_NAMES = [
  "LEARNED_KNOWLEDGE_CREATED",
  "LEARNED_KNOWLEDGE_REVISED",
  "LEARNED_KNOWLEDGE_CONFIRMED",
  "LEARNED_KNOWLEDGE_REJECTED",
  "LEARNED_KNOWLEDGE_TRANSITIONED",
] as const;

export type LearningEventName = (typeof LEARNING_EVENT_NAMES)[number];

export const learningEventNameSchema = z.enum(LEARNING_EVENT_NAMES);

export const PATTERN_EVENT_NAMES = [
  "PATTERN_EVIDENCE_SNAPSHOT_CREATED",
  "PATTERN_OBSERVATION_CREATED",
  "PATTERN_OBSERVATION_REVISED",
  "PATTERN_OBSERVATION_TRANSITIONED",
] as const;

export type PatternEventName = (typeof PATTERN_EVENT_NAMES)[number];

export const patternEventNameSchema = z.enum(PATTERN_EVENT_NAMES);

// --- Section 9.2: Inquiry events -------------------------------------------

export const INQUIRY_EVENT_NAMES = [
  "INQUIRY_CREATED",
  "INQUIRY_TRANSITIONED",
  "INQUIRY_RESPONSE_RECORDED",
  "INQUIRY_RESPONSE_CORRECTED",
  "INQUIRY_RESPONSE_PROCESSING_TRANSITIONED",
] as const;

export type InquiryEventName = (typeof INQUIRY_EVENT_NAMES)[number];

export const inquiryEventNameSchema = z.enum(INQUIRY_EVENT_NAMES);

// --- Section 9.3: Safety events --------------------------------------------

export const SAFETY_EVENT_NAMES = [
  "SAFETY_EVENT_OPENED",
  "SAFETY_EVENT_REEVALUATED",
  "SAFETY_EVENT_TRANSITIONED",
  "SAFETY_PRESENTATION_ACKNOWLEDGED",
  "SAFETY_RELATED_ACTION_LINKED",
  "SAFETY_RECHECK_LINKED",
  "SAFETY_DELIVERY_ATTEMPT_RECORDED",
  "SAFETY_DELIVERY_ATTEMPT_TRANSITIONED",
] as const;

export type SafetyEventName = (typeof SAFETY_EVENT_NAMES)[number];

export const safetyEventNameSchema = z.enum(SAFETY_EVENT_NAMES);

// --- Section 9.4: Care Preparation events -----------------------------------

export const CARE_PREPARATION_EVENT_NAMES = [
  "CARE_SUMMARY_SNAPSHOT_PREPARED",
  "CARE_SUMMARY_SNAPSHOT_PREVIEWED",
  "CARE_SUMMARY_SNAPSHOT_APPROVED",
  "CARE_SUMMARY_SNAPSHOT_INVALIDATED",
  "CARE_SUMMARY_SNAPSHOT_SUPERSEDED",
  "CARE_SUMMARY_EXPORT_REQUESTED",
  "CARE_SUMMARY_EXPORT_OUTCOME_RECORDED",
] as const;

export type CarePreparationEventName =
  (typeof CARE_PREPARATION_EVENT_NAMES)[number];

export const carePreparationEventNameSchema = z.enum(
  CARE_PREPARATION_EVENT_NAMES,
);

// --- Section 8.4: Patient-record deletion event ----------------------------

export const PATIENT_RECORD_DELETED_EVENT_NAMES = [
  "PATIENT_RECORD_DELETED",
] as const;

// --- Combined DomainEventName union (Section 5.1) --------------------------

export const DOMAIN_EVENT_NAMES = [
  ...PATIENT_SETTINGS_EVENT_NAMES,
  ...CARE_PLAN_EVENT_NAMES,
  ...HEALTH_RECORD_EVENT_NAMES,
  ...LEARNING_EVENT_NAMES,
  ...PATTERN_EVENT_NAMES,
  ...INQUIRY_EVENT_NAMES,
  ...SAFETY_EVENT_NAMES,
  ...CARE_PREPARATION_EVENT_NAMES,
  ...PATIENT_RECORD_DELETED_EVENT_NAMES,
] as const;

export type DomainEventName = (typeof DOMAIN_EVENT_NAMES)[number];

export const domainEventNameSchema = z.enum(DOMAIN_EVENT_NAMES);

// --- Packet 9B record-event ownership (event-contracts 8.2–8.3) -------------

/**
 * Closed producer and target record type for each Packet 9B care-organisation
 * event. Owner stores validate their event rows against this registry.
 */
export const PACKET_9B_EVENT_OWNERSHIP = Object.freeze({
  PREVENTIVE_CARE_ITEM_CREATED: Object.freeze({ producedBy: "CARE_PLAN", recordType: "PREVENTIVE_CARE_ITEM" }),
  PREVENTIVE_CARE_ITEM_REVISED: Object.freeze({ producedBy: "CARE_PLAN", recordType: "PREVENTIVE_CARE_ITEM" }),
  APPOINTMENT_SCHEDULED: Object.freeze({ producedBy: "CARE_PLAN", recordType: "APPOINTMENT" }),
  APPOINTMENT_REVISED: Object.freeze({ producedBy: "CARE_PLAN", recordType: "APPOINTMENT" }),
  PREVENTIVE_CARE_OUTCOME_RECORDED: Object.freeze({ producedBy: "HEALTH_RECORDS", recordType: "PREVENTIVE_CARE_RECORD" }),
  PREVENTIVE_CARE_OUTCOME_CORRECTED: Object.freeze({ producedBy: "HEALTH_RECORDS", recordType: "PREVENTIVE_CARE_RECORD" }),
  CONTEXT_WINDOW_RECORDED: Object.freeze({ producedBy: "HEALTH_RECORDS", recordType: "CONTEXT_WINDOW" }),
  CONTEXT_WINDOW_REVISED: Object.freeze({ producedBy: "HEALTH_RECORDS", recordType: "CONTEXT_WINDOW" }),
} as const);

// --- Packet 9C care-preparation event ownership (event-contracts 9.4) -------

/**
 * Closed producer and target record type for each Packet 9C event. No
 * delivered, reviewed or clinician-confirmed event exists in the MVP.
 */
export const PACKET_9C_EVENT_OWNERSHIP = Object.freeze({
  CARE_SUMMARY_SNAPSHOT_PREPARED: Object.freeze({ producedBy: "CARE_PREPARATION", recordType: "CARE_SUMMARY_SNAPSHOT" }),
  CARE_SUMMARY_SNAPSHOT_PREVIEWED: Object.freeze({ producedBy: "CARE_PREPARATION", recordType: "CARE_SUMMARY_SNAPSHOT" }),
  CARE_SUMMARY_SNAPSHOT_APPROVED: Object.freeze({ producedBy: "CARE_PREPARATION", recordType: "CARE_SUMMARY_SNAPSHOT" }),
  CARE_SUMMARY_SNAPSHOT_INVALIDATED: Object.freeze({ producedBy: "CARE_PREPARATION", recordType: "CARE_SUMMARY_SNAPSHOT" }),
  CARE_SUMMARY_SNAPSHOT_SUPERSEDED: Object.freeze({ producedBy: "CARE_PREPARATION", recordType: "CARE_SUMMARY_SNAPSHOT" }),
  CARE_SUMMARY_EXPORT_REQUESTED: Object.freeze({ producedBy: "CARE_PREPARATION", recordType: "CARE_SUMMARY_EXPORT" }),
  CARE_SUMMARY_EXPORT_OUTCOME_RECORDED: Object.freeze({ producedBy: "CARE_PREPARATION", recordType: "CARE_SUMMARY_EXPORT" }),
} as const);
