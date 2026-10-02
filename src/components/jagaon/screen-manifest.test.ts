import { describe, it, expect } from "vitest";
import {
  ALL_SCREENS,
  TOP_LEVEL_SCREENS,
  PACKET_6_CHILD_SCREENS,
  PACKET_6_ENABLED_SCREENS,
  type ScreenId,
} from "./screen-manifest";

describe("screen-manifest", () => {
  it("has exactly two top-level screens: TODAY and MORE", () => {
    expect(TOP_LEVEL_SCREENS).toEqual(["TODAY", "MORE"]);
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
    ]);
  });

  it("ALL_SCREENS matches the enabled set", () => {
    expect(ALL_SCREENS.size).toBe(PACKET_6_ENABLED_SCREENS.length);
    for (const screen of PACKET_6_ENABLED_SCREENS) {
      expect(ALL_SCREENS.has(screen)).toBe(true);
    }
  });

  it("has exactly the 11 screens named by the Packet 6 plan", () => {
    expect(ALL_SCREENS.size).toBe(11);
    expect(ALL_SCREENS.has("SETTINGS" as ScreenId)).toBe(false);
  });

  it("no Packet 7-9 route exists", () => {
    const deferred = [
      "TRENDS",
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
