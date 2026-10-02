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
  | "MY_MEDICINES";

// Settings (language and demo reset) render inside More, as in frame 12.

// --- Section: Frozen navigation arrays ------------------------------------

/** Bottom-navigation destinations — the only two top-level tabs. */
export const TOP_LEVEL_SCREENS: readonly ScreenId[] = Object.freeze([
  "TODAY",
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

/** Every enabled journal screen (top-level + Packet 6 and 6A children). */
export const PACKET_6_ENABLED_SCREENS: readonly ScreenId[] = Object.freeze([
  ...TOP_LEVEL_SCREENS,
  ...PACKET_6_CHILD_SCREENS,
  ...PACKET_6A_CHILD_SCREENS,
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
