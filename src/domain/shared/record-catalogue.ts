import { z } from "zod";

// --- Section 2.2: Record types ---

export const RECORD_TYPES = [
  // Patient settings
  "PATIENT_PROFILE",
  "PATIENT_PREFERENCE",
  "CONDITION",
  // Packet 13 (P13S; owner storage decision 2026-10-09): a patient-confirmed phrase → canonical medicine mapping.
  "PATIENT_TERMINOLOGY",

  // Care plan and organisation
  "MEDICATION",
  "PRESCRIPTION_VERSION",
  "PRESCRIPTION_CHANGE_CANDIDATE",
  "PREVENTIVE_CARE_ITEM",
  "APPOINTMENT",
  "CARE_QUESTION",
  "REMINDER",

  // Patient health records
  "GLUCOSE_READING",
  "KETONE_READING",
  "INTAKE_EVENT",
  "SYMPTOM_REPORT",
  "ACTIVITY_EVENT",
  "MEDICATION_EVENT",
  "BODY_MEASUREMENT",
  "PREVENTIVE_CARE_RECORD",
  "CONTEXT_WINDOW",
  // Owner decision 2026-10-14: a note the patient chose to keep about how she feels (My notes).
  "PERSONAL_NOTE",

  // Intelligence outputs
  "LEARNED_KNOWLEDGE",
  "PATTERN_OBSERVATION",
  "PATTERN_EVIDENCE_SNAPSHOT",

  // Patient interaction
  "INQUIRY",
  "INQUIRY_RESPONSE",

  // Safety
  "SAFETY_EVENT",
  "SAFETY_DELIVERY_ATTEMPT",

  // Care preparation
  "CARE_SUMMARY_SNAPSHOT",
  "CARE_SUMMARY_EXPORT",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export const recordTypeSchema = z.enum(RECORD_TYPES);

// --- Section 2.2: Authoritative owners ---

export const AUTHORITATIVE_OWNERS = [
  "PATIENT_SETTINGS",
  "CARE_PLAN",
  "HEALTH_RECORDS",
  "LEARNING_ENGINE",
  "PATTERN_ENGINE",
  "INQUIRY",
  "SAFETY_ROUTER",
  "CARE_PREPARATION",
] as const;

export type AuthoritativeOwner = (typeof AUTHORITATIVE_OWNERS)[number];

export const authoritativeOwnerSchema = z.enum(AUTHORITATIVE_OWNERS);

// --- Section 2.2: Ownership mapping ---

export const recordOwnerByType: Readonly<Record<RecordType, AuthoritativeOwner>> =
  Object.freeze({
    PATIENT_PROFILE: "PATIENT_SETTINGS",
    PATIENT_PREFERENCE: "PATIENT_SETTINGS",
    CONDITION: "PATIENT_SETTINGS",
    PATIENT_TERMINOLOGY: "PATIENT_SETTINGS",

    MEDICATION: "CARE_PLAN",
    PRESCRIPTION_VERSION: "CARE_PLAN",
    PRESCRIPTION_CHANGE_CANDIDATE: "CARE_PLAN",
    PREVENTIVE_CARE_ITEM: "CARE_PLAN",
    APPOINTMENT: "CARE_PLAN",
    CARE_QUESTION: "CARE_PLAN",
    REMINDER: "CARE_PLAN",

    GLUCOSE_READING: "HEALTH_RECORDS",
    KETONE_READING: "HEALTH_RECORDS",
    INTAKE_EVENT: "HEALTH_RECORDS",
    SYMPTOM_REPORT: "HEALTH_RECORDS",
    ACTIVITY_EVENT: "HEALTH_RECORDS",
    MEDICATION_EVENT: "HEALTH_RECORDS",
    BODY_MEASUREMENT: "HEALTH_RECORDS",
    PREVENTIVE_CARE_RECORD: "HEALTH_RECORDS",
    CONTEXT_WINDOW: "HEALTH_RECORDS",
    PERSONAL_NOTE: "HEALTH_RECORDS",

    LEARNED_KNOWLEDGE: "LEARNING_ENGINE",

    PATTERN_OBSERVATION: "PATTERN_ENGINE",
    PATTERN_EVIDENCE_SNAPSHOT: "PATTERN_ENGINE",

    INQUIRY: "INQUIRY",
    INQUIRY_RESPONSE: "INQUIRY",

    SAFETY_EVENT: "SAFETY_ROUTER",
    SAFETY_DELIVERY_ATTEMPT: "SAFETY_ROUTER",

    CARE_SUMMARY_SNAPSHOT: "CARE_PREPARATION",
    CARE_SUMMARY_EXPORT: "CARE_PREPARATION",
  });

export function getAuthoritativeOwner(
  recordType: RecordType,
): AuthoritativeOwner {
  return recordOwnerByType[recordType];
}

export function isOwnedBy(
  recordType: RecordType,
  owner: AuthoritativeOwner,
): boolean {
  return recordOwnerByType[recordType] === owner;
}

// --- Section 1.10: Deletion policy ---

export const DeletionPolicy = {
  PATIENT_DELETABLE: "PATIENT_DELETABLE",
  SYSTEM_RETENTION_REQUIRED: "SYSTEM_RETENTION_REQUIRED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
} as const;

export type DeletionPolicy = (typeof DeletionPolicy)[keyof typeof DeletionPolicy];

export const deletionPolicySchema = z.enum([
  "PATIENT_DELETABLE",
  "SYSTEM_RETENTION_REQUIRED",
  "NOT_APPLICABLE",
]);

// --- Section 2.5: Prescription change candidate state ---

export const PrescriptionChangeCandidateState = [
  "PENDING_RECONCILIATION",
  "RECONCILED_WITH_VERIFIED_SOURCE",
  "CONFLICTING_SOURCE",
  "DISMISSED",
  "SUPERSEDED",
] as const;

export type PrescriptionChangeCandidateState =
  (typeof PrescriptionChangeCandidateState)[number];

export const prescriptionChangeCandidateStateSchema = z.enum(
  PrescriptionChangeCandidateState,
);