import { describe, expect, it } from "vitest";
import { RECORD_TYPES } from "@/domain/shared/record-catalogue";
import { HACKATHON_STORAGE_PROFILE } from "./storage-profile-manifest";
import { JAGAON_TABLE_NAMES } from "./table-catalogue";

describe("HACKATHON_DEMO storage profile manifest (Packet 10 freeze Section 3)", () => {
  it("covers exactly the 16 physical tables and is immutable", () => {
    expect(HACKATHON_STORAGE_PROFILE.tables).toEqual(JAGAON_TABLE_NAMES);
    expect(HACKATHON_STORAGE_PROFILE.tables).toHaveLength(16);
    expect(Object.isFrozen(HACKATHON_STORAGE_PROFILE)).toBe(true);
    expect(Object.isFrozen(HACKATHON_STORAGE_PROFILE.writableRecordTypes)).toBe(true);
    expect(() => (HACKATHON_STORAGE_PROFILE.writableRecordTypes as string[]).push("SAFETY_EVENT")).toThrow();
  });

  // Packet 13 (P13S, Q13-8): + PATIENT_TERMINOLOGY. Owner decision 2026-10-14 (My notes): + PERSONAL_NOTE.
  it("freezes the 21 writable record types and partitions the catalogue", () => {
    expect(HACKATHON_STORAGE_PROFILE.writableRecordTypes).toHaveLength(21);
    expect([...HACKATHON_STORAGE_PROFILE.writableRecordTypes, ...HACKATHON_STORAGE_PROFILE.notWritableRecordTypes].sort()).toEqual([...RECORD_TYPES].sort());
    expect(HACKATHON_STORAGE_PROFILE.notWritableRecordTypes).toEqual([
      "PATIENT_PROFILE",
      "PATIENT_PREFERENCE",
      "CONDITION",
      "PRESCRIPTION_CHANGE_CANDIDATE",
      "KETONE_READING",
      "SYMPTOM_REPORT",
      "BODY_MEASUREMENT",
      "SAFETY_EVENT",
      "SAFETY_DELIVERY_ATTEMPT",
    ]);
  });

  it("keeps Packet 5A Safety absent from every profile path", () => {
    expect(HACKATHON_STORAGE_PROFILE.safetyRuntime).toBe("ABSENT");
    expect(HACKATHON_STORAGE_PROFILE.writableRecordTypes.some((type) => type.startsWith("SAFETY_"))).toBe(false);
    expect(HACKATHON_STORAGE_PROFILE.deletionOwnerOrder).not.toContain("SAFETY_ROUTER");
    expect(HACKATHON_STORAGE_PROFILE.deletionSafetyStep).toBe("NOT_ENABLED_IN_PROFILE");
    expect(HACKATHON_STORAGE_PROFILE.reconciliationSteps.find((step) => step.checkpoint === "SAFETY")?.disposition).toBe("NOT_ENABLED_IN_PROFILE");
  });

  it("freezes empty tables, metadata keys and the backup table set", () => {
    // Packet 11A enables only the AI invocation audit; the runtime-governance tables stay empty.
    expect(HACKATHON_STORAGE_PROFILE.emptyTables).toEqual(["runtimeManifests", "governedAssets", "runtimeActivationAudits"]);
    // Corrective Pass C: the approved operational cleanup marker; no Dexie or logical version change.
    expect(HACKATHON_STORAGE_PROFILE.metadataKeys).toEqual(["DATABASE_IDENTITY", "EVENT_SEQUENCE_HIGH_WATER_MARK", "MIGRATION_STATE", "RESTORE_STATE", "LOCAL_STATE_CLEANUP_PENDING"]);
    expect(HACKATHON_STORAGE_PROFILE.physicalDexieVersion).toBe(2);
    expect(HACKATHON_STORAGE_PROFILE.logicalStorageSchemaVersion).toBe(1);
    // Packet 11C Addendum C (C2, deliberate change): the patient's "Keep wording on this device" setting joins the language row.
    expect(HACKATHON_STORAGE_PROFILE.appPreferenceKeys).toEqual(["language", "keepWordingOnDevice"]);
    expect(HACKATHON_STORAGE_PROFILE.backupExcludedTables).toEqual(["appPreferences", "storageMetadata"]);
    expect(HACKATHON_STORAGE_PROFILE.backupTables).toEqual([
      "recordRevisions",
      "recordHeads",
      "deletionTombstones",
      "auditEvents",
      "domainEvents",
      "commandReceipts",
      "eventWorkItems",
      "eventConsumerReceipts",
      "reverseDependencies",
      "engineEvaluationAudits",
      "aiInvocationAudits",
      "runtimeManifests",
      "governedAssets",
      "runtimeActivationAudits",
    ]);
  });

  it("freezes versions, deletion order and the reconciliation order", () => {
    expect(HACKATHON_STORAGE_PROFILE.physicalDexieVersion).toBe(2);
    expect(HACKATHON_STORAGE_PROFILE.logicalStorageSchemaVersion).toBe(1);
    // Packet 13 (P13S, Q13-8): "forget" a remembered term is a patient permanent deletion.
    // Owner decision 2026-10-14 (My notes): deleting one note is a patient permanent deletion.
    expect(HACKATHON_STORAGE_PROFILE.permanentDeletionTargets).toEqual(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT", "PATIENT_TERMINOLOGY", "PERSONAL_NOTE"]);
    expect(HACKATHON_STORAGE_PROFILE.deletionOwnerOrder).toEqual(["HEALTH_RECORDS", "PATTERN_ENGINE", "LEARNING_ENGINE", "INQUIRY", "CARE_PLAN", "CARE_PREPARATION"]);
    expect(HACKATHON_STORAGE_PROFILE.reconciliationSteps.map((step) => step.checkpoint)).toEqual([
      "VERIFY_STORAGE",
      "VERIFY_REVERSE_DEPENDENCIES",
      "REBUILD_BOOTSTRAP_LOCALE",
      "RUNTIME_POINTERS",
      "RECOVER_WORK_LEASES",
      "SAFETY",
      "INQUIRY_MAINTENANCE",
      "PATTERN_LEARNING_REFRESH",
      "REMINDER_RECONCILIATION",
      "CARE_SUMMARY_INVALIDATION",
    ]);
  });
});
