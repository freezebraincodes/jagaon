import type { RecordHead } from "../shared/revision";
import type { RecordId, RevisionId } from "../shared/identifiers";
import type { Instant } from "../shared/time";
import type { PatientPreferencePayload } from "./preferences";

// --- Section 3.2 / 3.8: Pure collection-invariant checks ---

// A PreferenceHead pairs the typed preference kind with the record head's
// identity, type, state, and revision metadata. The kind is typed so that
// only approved preference kinds compose — unrestricted strings are not
// accepted.
export type PreferenceHead = {
  kind: PatientPreferencePayload["kind"];
  recordType: string;
  recordId: RecordId;
  headRevisionId: RevisionId;
  headRevisionNumber: number;
  state: "ACTIVE" | "DELETED";
  updatedAt: Instant;
};

// The five approved patient-preference kinds for the Singapore MVP.
const APPROVED_PREFERENCE_KINDS: readonly PatientPreferencePayload["kind"][] = [
  "LANGUAGE",
  "GLUCOSE_DISPLAY_UNIT",
  "ACCESSIBILITY",
  "HOME_TIME_ZONE",
  "COMMUNICATION",
];

// Determines whether the supplied heads contain exactly one active head
// whose record type is PATIENT_PROFILE.
export function validateSingleActiveProfile(
  profileHeads: RecordHead[],
): boolean {
  const activeCount = profileHeads.filter(
    (h) => h.state === "ACTIVE" && h.recordType === "PATIENT_PROFILE",
  ).length;
  return activeCount === 1;
}

// Determines whether there is exactly one active PATIENT_PREFERENCE for each
// approved kind:
//   LANGUAGE, GLUCOSE_DISPLAY_UNIT, ACCESSIBILITY, HOME_TIME_ZONE, COMMUNICATION
//
// Deleted heads are not counted as active. A non-PATIENT_PREFERENCE head
// cannot satisfy a preference. Different preference kinds must use
// independent record identities.
export function validateOneActivePreferencePerKind(
  entries: PreferenceHead[],
): boolean {
  // Count active entries per kind, checking record type and tracking
  // record identities.
  const activeByKind = new Map<PatientPreferencePayload["kind"], number>();
  const seenRecordIds = new Set<string>();

  for (const entry of entries) {
    if (entry.state !== "ACTIVE") continue;

    // A non-PATIENT_PREFERENCE head cannot satisfy a preference.
    if (entry.recordType !== "PATIENT_PREFERENCE") return false;

    // Distinct preference kinds must use independent record identities.
    const rid = entry.recordId as unknown as string;
    if (seenRecordIds.has(rid)) return false;
    seenRecordIds.add(rid);

    const prev = activeByKind.get(entry.kind) ?? 0;
    activeByKind.set(entry.kind, prev + 1);
  }

  // Every approved kind must have exactly one active entry.
  for (const kind of APPROVED_PREFERENCE_KINDS) {
    if (activeByKind.get(kind) !== 1) return false;
  }

  // Reject extra active entries for any kind not in the approved set.
  // (All kinds are from the typed enum, so this is already guaranteed.)

  return true;
}