import { HACKATHON_STORAGE_PROFILE, type ReconciliationStep } from "@/storage/storage-profile-manifest";

/**
 * Closed enabled-owner registry for post-restore reconciliation (spec 8.7;
 * Packet 10 freeze Section 10). Every profile step is either bound to one
 * enabled owner operation or explicitly not enabled in this profile; an
 * undeclared or unbound step fails rather than counting as success. Packet
 * 5A Safety is `NOT_ENABLED_IN_PROFILE` and no Safety module is imported.
 */

export type ReconciliationOwnerKey =
  | "STORAGE_VERIFIER"
  | "DEPENDENCY_VERIFIER"
  | "BOOTSTRAP_LOCALE"
  | "RUNTIME_POINTER_VERIFIER"
  | "WORK_LEASE_RECOVERY"
  | "INQUIRY"
  | "PATTERN_LEARNING"
  | "REMINDERS"
  | "CARE_SUMMARY";

export const RECONCILIATION_OWNER_BY_STEP: Readonly<Record<ReconciliationStep["checkpoint"], ReconciliationOwnerKey | "NOT_ENABLED_IN_PROFILE">> = Object.freeze({
  VERIFY_STORAGE: "STORAGE_VERIFIER",
  VERIFY_REVERSE_DEPENDENCIES: "DEPENDENCY_VERIFIER",
  REBUILD_BOOTSTRAP_LOCALE: "BOOTSTRAP_LOCALE",
  RUNTIME_POINTERS: "RUNTIME_POINTER_VERIFIER",
  RECOVER_WORK_LEASES: "WORK_LEASE_RECOVERY",
  SAFETY: "NOT_ENABLED_IN_PROFILE",
  INQUIRY_MAINTENANCE: "INQUIRY",
  PATTERN_LEARNING_REFRESH: "PATTERN_LEARNING",
  REMINDER_RECONCILIATION: "REMINDERS",
  CARE_SUMMARY_INVALIDATION: "CARE_SUMMARY",
});

export type ReconciliationPlanStep = { checkpoint: ReconciliationStep["checkpoint"]; owner: ReconciliationOwnerKey | null };

/** The ordered, closed reconciliation plan for the compiled profile. */
export function reconciliationPlan(steps: readonly ReconciliationStep[] = HACKATHON_STORAGE_PROFILE.reconciliationSteps): ReconciliationPlanStep[] {
  return steps.map((step) => {
    const owner = RECONCILIATION_OWNER_BY_STEP[step.checkpoint];
    if (owner === undefined) throw new Error("RECONCILIATION_STEP_UNDECLARED");
    if (step.disposition === "NOT_ENABLED_IN_PROFILE") {
      if (owner !== "NOT_ENABLED_IN_PROFILE") throw new Error("RECONCILIATION_DISPOSITION_MISMATCH");
      return { checkpoint: step.checkpoint, owner: null };
    }
    if (owner === "NOT_ENABLED_IN_PROFILE") throw new Error("RECONCILIATION_OWNER_MISSING");
    return { checkpoint: step.checkpoint, owner };
  });
}
