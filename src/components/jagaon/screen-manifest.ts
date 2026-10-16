/**
 * Packet 6 screen manifest.
 *
 * Every navigable screen in the bilingual journal UI is enumerated here so
 * the client application boundary can switch on a typed value rather than a
 * raw string.
 *
 * The manifest is split into top-level navigation destinations and child
 * screens so the shell can distinguish tab-level routing from pushed
 * sub-screens.
 */

// --- Section: Closed screen-id union --------------------------------------

export type ScreenId =
  /** Top-level: Today dashboard (frame 01) */
  | "TODAY"
  /** Top-level (Packet 8): Medication schedule, the Booklet tab (v1 frame 11) */
  | "MEDICATION_SCHEDULE"
  /** Top-level (Packet 7A): Recorded history (v1 frame 06) */
  | "HISTORY"
  /** Top-level: More screen (frame 12) */
  | "MORE"
  /** Child: Log glucose reading (frame 02) */
  | "LOG_GLUCOSE"
  /** Child: Change reading time (frame 03) */
  | "CHANGE_READING_TIME"
  /** Child: Record insulin (frame 04) */
  | "RECORD_INSULIN"
  /** Child: Log a meal (frame 05) */
  | "LOG_MEAL"
  /** Child: Medication information (frame 08) */
  | "MEDICATION_INFORMATION"
  /** Child: Nearby food ideas — all 12 states (frame 07) */
  | "NEARBY_FOOD"
  /** Child: General food information (frame 07 sub) */
  | "GENERAL_FOOD_INFORMATION"
  /** Child: Food venue details (frame 07 details) */
  | "FOOD_VENUE_DETAILS"
  /** Child: Help and emergency information (frame 13) */
  | "HELP_INFORMATION"
  /** Child (Packet 6A): post-setup My medicines management */
  | "MY_MEDICINES"
  /** Child (Packet 9B): My health checks (v1 frame 09) */
  | "PREVENTIVE_CARE"
  /** Child (Packet 9B): Prepare for my appointment (v1 frame 10) */
  | "CARE_PREPARATION"
  /** Child (Packet 9C): care-summary preview, approval and local print, reached from Screen 10 */
  | "CARE_SUMMARY_PREVIEW"
  /** Child (Packet 10): Data and backup, distinct from "Export to other apps" */
  | "DATA_BACKUP"
  /** Child (Packet 13 slice): Tell JagaOn voice logging, reached from Today */
  | "TELL_JAGAON"
  /** Child (owner decision 2026-10-12): My notes, reached from More */
  | "MY_NOTES"
  /** Child (owner request 2026-10-16): Record an activity, reached from Today and Tell JagaOn */
  | "RECORD_ACTIVITY";

// Settings (language and demo reset) render inside More, as in frame 12.

// --- Section: Frozen navigation arrays ------------------------------------

/**
 * Packet 7A top-level destination, enabled only now that the validated
 * Recorded-history query path exists.
 */
export const PACKET_7A_TOP_LEVEL_SCREENS: readonly ScreenId[] = Object.freeze(["HISTORY"]);

/**
 * Packet 8 top-level destination: the existing Booklet tab is enabled as the
 * authorised Medication schedule route. It is the only Booklet destination.
 */
export const PACKET_8_TOP_LEVEL_SCREENS: readonly ScreenId[] = Object.freeze(["MEDICATION_SCHEDULE"]);

/** Bottom-navigation destinations in navigation order. */
export const TOP_LEVEL_SCREENS: readonly ScreenId[] = Object.freeze([
  "TODAY",
  ...PACKET_8_TOP_LEVEL_SCREENS,
  ...PACKET_7A_TOP_LEVEL_SCREENS,
  "MORE",
]);

/** Every Packet 6 child screen, exactly once. */
export const PACKET_6_CHILD_SCREENS: readonly ScreenId[] = Object.freeze([
  "LOG_GLUCOSE",
  "CHANGE_READING_TIME",
  "RECORD_INSULIN",
  "LOG_MEAL",
  "MEDICATION_INFORMATION",
  "NEARBY_FOOD",
  "GENERAL_FOOD_INFORMATION",
  "FOOD_VENUE_DETAILS",
  "HELP_INFORMATION",
]);

/** Packet 6A post-setup management destination, reached from More/Today. */
export const PACKET_6A_CHILD_SCREENS: readonly ScreenId[] = Object.freeze(["MY_MEDICINES"]);

/** Packet 9B care-organisation destinations, reached from More and Today. */
export const PACKET_9B_CHILD_SCREENS: readonly ScreenId[] = Object.freeze(["PREVENTIVE_CARE", "CARE_PREPARATION"]);

/** Packet 9C care-summary preview, reached only from Prepare for my visit. */
export const PACKET_9C_CHILD_SCREENS: readonly ScreenId[] = Object.freeze(["CARE_SUMMARY_PREVIEW"]);

/** Packet 10 Data and backup destination, reached from More (and Settings). */
export const PACKET_10_CHILD_SCREENS: readonly ScreenId[] = Object.freeze(["DATA_BACKUP"]);

/** Packet 13 slice: Tell JagaOn, reached from Today (shown also while voice is unavailable; owner decision "Voice entry"). */
export const PACKET_13_CHILD_SCREENS: readonly ScreenId[] = Object.freeze(["TELL_JAGAON"]);
/** Owner decision 2026-10-12: My notes, reached from More (replaces the Reminders placeholder tile). */
export const MY_NOTES_CHILD_SCREENS: readonly ScreenId[] = Object.freeze(["MY_NOTES"]);
/** Owner request 2026-10-16: Record an activity, the tap form reached from Today's Activity tile and Tell JagaOn's chooser. */
export const ACTIVITY_ENTRY_CHILD_SCREENS: readonly ScreenId[] = Object.freeze(["RECORD_ACTIVITY"]);

/** Every enabled journal screen (top-level + Packet 6, 6A, 9B, 9C and 10 children). */
export const PACKET_6_ENABLED_SCREENS: readonly ScreenId[] = Object.freeze([
  ...TOP_LEVEL_SCREENS,
  ...PACKET_6_CHILD_SCREENS,
  ...PACKET_6A_CHILD_SCREENS,
  ...PACKET_9B_CHILD_SCREENS,
  ...PACKET_9C_CHILD_SCREENS,
  ...PACKET_10_CHILD_SCREENS,
  ...PACKET_13_CHILD_SCREENS,
  ...MY_NOTES_CHILD_SCREENS,
  ...ACTIVITY_ENTRY_CHILD_SCREENS,
]);

/**
 * Closed first-run onboarding routes. They render in the onboarding shell
 * (no bottom navigation) and are never journal screens or tabs.
 */
export { DEMO_ONBOARDING_ROUTES as ONBOARDING_ROUTES } from "@/application/onboarding/demo-onboarding-contracts";

/**
 * The complete set of enabled screens, used by tests to verify
 * completeness and by the app shell to validate navigation targets.
 */
export const ALL_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(
  PACKET_6_ENABLED_SCREENS,
);
