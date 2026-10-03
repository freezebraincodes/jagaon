import { describe, it, expect } from "vitest";
import {
  ALL_SCREENS,
  TOP_LEVEL_SCREENS,
  PACKET_6_CHILD_SCREENS,
  PACKET_6_ENABLED_SCREENS,
  PACKET_6A_CHILD_SCREENS,
  PACKET_7A_TOP_LEVEL_SCREENS,
  ONBOARDING_ROUTES,
  type ScreenId,
} from "./screen-manifest";

describe("screen-manifest", () => {
  it("has exactly three top-level screens in navigation order: TODAY, HISTORY and MORE", () => {
    expect(TOP_LEVEL_SCREENS).toEqual(["TODAY", "HISTORY", "MORE"]);
    expect(PACKET_7A_TOP_LEVEL_SCREENS).toEqual(["HISTORY"]);
    expect(Object.isFrozen(PACKET_7A_TOP_LEVEL_SCREENS)).toBe(true);
  });

  it("keeps Booklet absent: it is not authorised by any accepted packet", () => {
    expect(ALL_SCREENS.has("BOOKLET" as ScreenId)).toBe(false);
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

  it("has the 11 Packet 6 screens, Packet 6A My medicines and Packet 7A Recorded history", () => {
    expect(PACKET_6A_CHILD_SCREENS).toEqual(["MY_MEDICINES"]);
    expect(ALL_SCREENS.size).toBe(13);
    expect(ALL_SCREENS.has("HISTORY")).toBe(true);
    expect(ALL_SCREENS.has("MY_MEDICINES")).toBe(true);
    expect(ALL_SCREENS.has("SETTINGS" as ScreenId)).toBe(false);
  });

  it("no Packet 7B-9 route exists", () => {
    const deferred = [
      "TRENDS",
      "ROUTINE_SHIFT",
      "PATTERN_INSIGHTS",
      "APPOINTMENT_NOTES",
      "CARE_SUMMARY",
      "WEEKLY_TRENDS",
      "REMINDERS",
      "CREATE_REMINDER",
      "PREVENTIVE_CARE",
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
