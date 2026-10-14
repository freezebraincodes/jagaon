import { RECORD_TYPES, type AuthoritativeOwner, type RecordType } from "@/domain/shared/record-catalogue";
import { EMPTY_IN_PROFILE_TABLES } from "./closed-row-codecs";
import { LOGICAL_STORAGE_SCHEMA_VERSION, PROFILE_METADATA_KEYS, RESTORE_CHECKPOINTS, type RestoreCheckpoint } from "./storage-metadata";
import { JAGAON_DEXIE_VERSION, JAGAON_TABLE_NAMES, type JagaOnTableName } from "./table-catalogue";

/**
 * Immutable compile-time `HACKATHON_DEMO` storage profile (storage-backup-spec
 * Section 0; Packet 10 freeze Sections 3, 8 and 10). Storage, backup,
 * deletion and restore read this manifest; none of them may widen it at
 * runtime. Packet 5A Safety is absent from every list.
 */

export type ProfileStepDisposition = "ENABLED" | "NOT_ENABLED_IN_PROFILE";

export type ReconciliationStep = {
  checkpoint: Exclude<RestoreCheckpoint, "COMMITTED">;
  disposition: ProfileStepDisposition;
};

export type StorageProfileManifest = {
  profileId: "HACKATHON_DEMO";
  physicalDexieVersion: number;
  logicalStorageSchemaVersion: number;
  tables: readonly JagaOnTableName[];
  writableRecordTypes: readonly RecordType[];
  notWritableRecordTypes: readonly RecordType[];
  emptyTables: readonly JagaOnTableName[];
  metadataKeys: readonly string[];
  appPreferenceKeys: readonly string[];
  backupTables: readonly JagaOnTableName[];
  backupExcludedTables: readonly JagaOnTableName[];
  permanentDeletionTargets: readonly RecordType[];
  deletionOwnerOrder: readonly AuthoritativeOwner[];
  deletionSafetyStep: ProfileStepDisposition;
  reconciliationSteps: readonly ReconciliationStep[];
  safetyRuntime: "ABSENT";
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const WRITABLE_RECORD_TYPES: readonly RecordType[] = [
  "GLUCOSE_READING",
  "MEDICATION_EVENT",
  "INTAKE_EVENT",
  "ACTIVITY_EVENT",
  "MEDICATION",
  "PRESCRIPTION_VERSION",
  "REMINDER",
  "PREVENTIVE_CARE_ITEM",
  "APPOINTMENT",
  "CARE_QUESTION",
  "PREVENTIVE_CARE_RECORD",
  "CONTEXT_WINDOW",
  "INQUIRY",
  "INQUIRY_RESPONSE",
  "LEARNED_KNOWLEDGE",
  "PATTERN_OBSERVATION",
  "PATTERN_EVIDENCE_SNAPSHOT",
  "CARE_SUMMARY_SNAPSHOT",
  "CARE_SUMMARY_EXPORT",
  // Packet 13 (P13S; owner storage decision 2026-10-09).
  "PATIENT_TERMINOLOGY",
  // Owner decision 2026-10-14 (My notes).
  "PERSONAL_NOTE",
];

const BACKUP_EXCLUDED_TABLES: readonly JagaOnTableName[] = ["appPreferences", "storageMetadata"];

export const HACKATHON_STORAGE_PROFILE: StorageProfileManifest = deepFreeze({
  profileId: "HACKATHON_DEMO",
  physicalDexieVersion: JAGAON_DEXIE_VERSION,
  logicalStorageSchemaVersion: LOGICAL_STORAGE_SCHEMA_VERSION,
  tables: [...JAGAON_TABLE_NAMES],
  writableRecordTypes: [...WRITABLE_RECORD_TYPES],
  notWritableRecordTypes: RECORD_TYPES.filter((type) => !WRITABLE_RECORD_TYPES.includes(type)),
  emptyTables: [...EMPTY_IN_PROFILE_TABLES],
  metadataKeys: [...PROFILE_METADATA_KEYS],
  // Packet 11C Addendum C (C2): the patient's "Keep wording on this device" setting (a versioned row; see app-preference-row.ts).
  appPreferenceKeys: ["language", "keepWordingOnDevice"],
  backupTables: JAGAON_TABLE_NAMES.filter((table) => !BACKUP_EXCLUDED_TABLES.includes(table)),
  backupExcludedTables: [...BACKUP_EXCLUDED_TABLES],
  // Packet 13 (P13S): "forget" a remembered term is a patient permanent deletion (no phrase remains in any revision).
  // Owner decision 2026-10-14: deleting one note from My notes is a patient permanent deletion (no note text remains).
  permanentDeletionTargets: ["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT", "PATIENT_TERMINOLOGY", "PERSONAL_NOTE"],
  deletionOwnerOrder: ["HEALTH_RECORDS", "PATTERN_ENGINE", "LEARNING_ENGINE", "INQUIRY", "CARE_PLAN", "CARE_PREPARATION"],
  deletionSafetyStep: "NOT_ENABLED_IN_PROFILE",
  reconciliationSteps: RESTORE_CHECKPOINTS.filter((checkpoint): checkpoint is Exclude<RestoreCheckpoint, "COMMITTED"> => checkpoint !== "COMMITTED").map(
    (checkpoint) => ({ checkpoint, disposition: checkpoint === "SAFETY" ? ("NOT_ENABLED_IN_PROFILE" as const) : ("ENABLED" as const) }),
  ),
  safetyRuntime: "ABSENT",
});
