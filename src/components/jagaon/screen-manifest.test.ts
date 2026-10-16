import { describe, it, expect } from "vitest";
import {
  ALL_SCREENS,
  TOP_LEVEL_SCREENS,
  PACKET_6_CHILD_SCREENS,
  PACKET_6_ENABLED_SCREENS,
  PACKET_6A_CHILD_SCREENS,
  PACKET_7A_TOP_LEVEL_SCREENS,
  BOOKLET_TOP_LEVEL_SCREENS,
  PACKET_8_CHILD_SCREENS,
  PACKET_9B_CHILD_SCREENS,
  PACKET_9C_CHILD_SCREENS,
  PACKET_10_CHILD_SCREENS,
  PACKET_13_CHILD_SCREENS,
  MY_NOTES_CHILD_SCREENS,
  ACTIVITY_ENTRY_CHILD_SCREENS,
  ONBOARDING_ROUTES,
  type ScreenId,
} from "./screen-manifest";

describe("screen-manifest", () => {
  it("has exactly four top-level screens in navigation order: TODAY, BOOKLET, HISTORY and MORE", () => {
    // Owner decision 2026-10-16: the Booklet tab opens the paper-diary table; the Medication schedule is a child reached from More.
    expect(TOP_LEVEL_SCREENS).toEqual(["TODAY", "BOOKLET", "HISTORY", "MORE"]);
    expect(PACKET_7A_TOP_LEVEL_SCREENS).toEqual(["HISTORY"]);
    expect(BOOKLET_TOP_LEVEL_SCREENS).toEqual(["BOOKLET"]);
    expect(PACKET_8_CHILD_SCREENS).toEqual(["MEDICATION_SCHEDULE"]);
    expect(Object.isFrozen(PACKET_7A_TOP_LEVEL_SCREENS)).toBe(true);
    expect(Object.isFrozen(BOOKLET_TOP_LEVEL_SCREENS)).toBe(true);
    expect(Object.isFrozen(PACKET_8_CHILD_SCREENS)).toBe(true);
  });

  it("has one Booklet table and one Medication schedule, with no duplicate destination", () => {
    expect([...ALL_SCREENS].filter((screen) => /SCHEDULE|REMINDER|BOOKLET|CARE_QUESTION/.test(screen))).toEqual(["BOOKLET", "MEDICATION_SCHEDULE"]);
    expect(TOP_LEVEL_SCREENS).not.toContain("MEDICATION_SCHEDULE");
  });

  it("lists every Packet 6 child exactly once", () => {
    expect(PACKET_6_CHILD_SCREENS).toEqual([
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
    // No duplicates
    expect(new Set(PACKET_6_CHILD_SCREENS).size).toBe(
      PACKET_6_CHILD_SCREENS.length,
    );
  });

  it("enabled screens is the union of top-level and child screens", () => {
    expect(PACKET_6_ENABLED_SCREENS).toEqual([
      ...TOP_LEVEL_SCREENS,
      ...PACKET_6_CHILD_SCREENS,
      ...PACKET_6A_CHILD_SCREENS,
      ...PACKET_8_CHILD_SCREENS,
      ...PACKET_9B_CHILD_SCREENS,
      ...PACKET_9C_CHILD_SCREENS,
      ...PACKET_10_CHILD_SCREENS,
      ...PACKET_13_CHILD_SCREENS,
      ...MY_NOTES_CHILD_SCREENS,
      ...ACTIVITY_ENTRY_CHILD_SCREENS,
    ]);
  });

  it("keeps onboarding routes closed and separate from bottom navigation", () => {
    expect(ONBOARDING_ROUTES).toEqual([
      "WELCOME", "PROFILE", "MEDICINES", "ADD_MEDICINE", "DIRECTIONS",
      "REVIEW", "COMPLETE", "RESUME", "SKIPPED", "STORAGE_FAILURE",
    ]);
    expect(Object.isFrozen(ONBOARDING_ROUTES)).toBe(true);
    for (const route of ONBOARDING_ROUTES) {
      expect(ALL_SCREENS.has(route as ScreenId)).toBe(false);
      expect(TOP_LEVEL_SCREENS).not.toContain(route);
    }
    expect(Object.isFrozen(PACKET_6A_CHILD_SCREENS)).toBe(true);
  });

  it("ALL_SCREENS matches the enabled set", () => {
    expect(ALL_SCREENS.size).toBe(PACKET_6_ENABLED_SCREENS.length);
    for (const screen of PACKET_6_ENABLED_SCREENS) {
      expect(ALL_SCREENS.has(screen)).toBe(true);
    }
  });

  it("has the 11 Packet 6 screens, Packet 6A My medicines, Packet 7A Recorded history, Packet 8 Medication schedule and the two Packet 9B child screens", () => {
    expect(PACKET_6A_CHILD_SCREENS).toEqual(["MY_MEDICINES"]);
    expect(PACKET_9B_CHILD_SCREENS).toEqual(["PREVENTIVE_CARE", "CARE_PREPARATION"]);
    expect(Object.isFrozen(PACKET_9B_CHILD_SCREENS)).toBe(true);
    expect(PACKET_9C_CHILD_SCREENS).toEqual(["CARE_SUMMARY_PREVIEW"]);
    // Packet 10: one distinct Data and backup destination.
    expect(PACKET_10_CHILD_SCREENS).toEqual(["DATA_BACKUP"]);
    // Packet 13 slice: one Tell JagaOn destination, reached from Today.
    expect(PACKET_13_CHILD_SCREENS).toEqual(["TELL_JAGAON"]);
    // Owner decision 2026-10-12: My notes adds exactly MY_NOTES (reached from More).
    expect(MY_NOTES_CHILD_SCREENS).toEqual(["MY_NOTES"]);
    // Owner request 2026-10-16: Record an activity adds exactly RECORD_ACTIVITY (reached from Today and Tell JagaOn).
    expect(ACTIVITY_ENTRY_CHILD_SCREENS).toEqual(["RECORD_ACTIVITY"]);
    expect(Object.isFrozen(ACTIVITY_ENTRY_CHILD_SCREENS)).toBe(true);
    // Owner decision 2026-10-16: the Booklet table adds exactly BOOKLET.
    expect(ALL_SCREENS.size).toBe(22);
    expect(ALL_SCREENS.has("MEDICATION_SCHEDULE")).toBe(true);
    expect(ALL_SCREENS.has("HISTORY")).toBe(true);
    expect(ALL_SCREENS.has("MY_MEDICINES")).toBe(true);
    expect(ALL_SCREENS.has("SETTINGS" as ScreenId)).toBe(false);
  });

  it("no Packet 7B, 9C or later route exists", () => {
    const deferred = [
      "TRENDS",
      "ROUTINE_SHIFT",
      "PATTERN_INSIGHTS",
      "APPOINTMENT_NOTES",
      "CARE_SUMMARY",
      "WEEKLY_TRENDS",
      "REMINDERS",
      "CREATE_REMINDER",
      "APPOINTMENTS",
      "SCHEDULE_APPOINTMENT",
      "LIVE_FOOD_PROVIDER",
    ];
    for (const route of deferred) {
      expect(ALL_SCREENS.has(route as ScreenId)).toBe(false);
    }
  });

  it("ScreenId is a string union", () => {
    const sample: ScreenId = "TODAY";
    expect(typeof sample).toBe("string");
  });
});
