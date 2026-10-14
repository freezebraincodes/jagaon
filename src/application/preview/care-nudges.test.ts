import { describe, expect, it } from "vitest";
import {
  CARE_INTERVALS_PREVIEW,
  CARE_INTERVALS_PREVIEW_VERSION,
  addMonths,
  computeCareNudges,
  singaporeLocalDate,
  wholeMonthsBetween,
} from "./care-nudges";

// Wednesday 14 Oct 2026, 10:00 in Singapore (the demo day).
const NOW = new Date("2026-10-14T02:00:00.000Z");
const nudge = (summary: ReturnType<typeof computeCareNudges>, key: string) => summary.nudges.find((entry) => entry.key === key)!;

describe("care-intervals-preview.1 (HSA-bounded mode off only)", () => {
  it("is a versioned table of the three standard intervals, without flu vaccine", () => {
    expect(CARE_INTERVALS_PREVIEW.version).toBe(CARE_INTERVALS_PREVIEW_VERSION);
    expect(CARE_INTERVALS_PREVIEW_VERSION).toBe("care-intervals-preview.1");
    expect(CARE_INTERVALS_PREVIEW.entries.map((entry) => [entry.key, entry.intervalMonths, entry.cadence])).toEqual([
      ["EYE_SCREENING", 12, "YEARLY"],
      ["FOOT_CHECK", 12, "YEARLY"],
      ["BLOOD_TEST", 6, "EVERY_3_TO_6_MONTHS"],
    ]);
  });

  it("uses the Singapore calendar date of the injected time", () => {
    expect(singaporeLocalDate(new Date("2026-10-13T15:59:59.000Z"))).toBe("2026-10-13");
    expect(singaporeLocalDate(new Date("2026-10-13T16:00:00.000Z"))).toBe("2026-10-14");
  });

  it("adds calendar months, keeping to the last day of a shorter month", () => {
    expect(addMonths("2025-09-09", 12)).toBe("2026-09-09");
    expect(addMonths("2026-05-12", 6)).toBe("2026-11-12");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("counts whole months consistently with month addition", () => {
    expect(wholeMonthsBetween("2025-09-09", "2026-10-14")).toBe(13);
    expect(wholeMonthsBetween("2025-09-16", "2026-10-14")).toBe(12);
    expect(wholeMonthsBetween("2026-08-31", "2026-09-30")).toBe(1);
    expect(wholeMonthsBetween("2026-10-14", "2026-10-01")).toBe(0);
  });

  it("treats a check with no recorded completion as due", () => {
    const summary = computeCareNudges([], NOW);
    expect(summary.dueCount).toBe(3);
    for (const entry of summary.nudges) {
      expect(entry).toMatchObject({ status: "DUE", lastDoneOn: null, monthsSinceLastDone: null, dueOn: null, dueIn: null });
    }
  });

  it("is due on and after the due date, due soon within the 30 days before, and not due otherwise", () => {
    const at = (localDate: string) => nudge(computeCareNudges([{ catalogueEntryKey: "EYE_SCREENING", localDate }], NOW), "EYE_SCREENING");
    expect(at("2025-10-14")).toMatchObject({ status: "DUE", dueOn: "2026-10-14", monthsSinceLastDone: 12, dueIn: null });
    expect(at("2025-10-15")).toMatchObject({ status: "DUE_SOON", dueOn: "2026-10-15", dueIn: { unit: "DAYS", count: 1 } });
    expect(at("2025-11-13")).toMatchObject({ status: "DUE_SOON", dueOn: "2026-11-13", dueIn: { unit: "WEEKS", count: 4 } });
    expect(at("2025-11-14")).toMatchObject({ status: "NOT_DUE", dueOn: "2026-11-14", dueIn: { unit: "MONTHS", count: 1 } });
    expect(at("2026-09-14")).toMatchObject({ status: "NOT_DUE", monthsSinceLastDone: 1, dueIn: { unit: "MONTHS", count: 11 } });
  });

  it("makes HbA1c (blood test) due at 6 months, not at 3", () => {
    const at = (localDate: string) => nudge(computeCareNudges([{ catalogueEntryKey: "BLOOD_TEST", localDate }], NOW), "BLOOD_TEST");
    expect(at("2026-07-14").status).toBe("NOT_DUE");
    expect(at("2026-04-14")).toMatchObject({ status: "DUE", dueOn: "2026-10-14" });
    expect(at("2026-05-12")).toMatchObject({ status: "DUE_SOON", dueOn: "2026-11-12", dueIn: { unit: "WEEKS", count: 4 } });
  });

  it("uses the latest completion, ignores other checks and any completion dated after today", () => {
    const summary = computeCareNudges(
      [
        { catalogueEntryKey: "FOOT_CHECK", localDate: "2024-01-01" },
        { catalogueEntryKey: "FOOT_CHECK", localDate: "2026-09-14" },
        { catalogueEntryKey: "FOOT_CHECK", localDate: "2026-12-01" },
        { catalogueEntryKey: "FLU_VACCINE", localDate: "2026-10-01" },
      ],
      NOW,
    );
    expect(nudge(summary, "FOOT_CHECK")).toMatchObject({ status: "NOT_DUE", lastDoneOn: "2026-09-14" });
    expect(summary.nudges.map((entry) => entry.key)).not.toContain("FLU_VACCINE");
  });

  it("lists due checks first and counts only DUE (the demo seed: eye screening due, blood test soon, foot check later)", () => {
    const summary = computeCareNudges(
      [
        { catalogueEntryKey: "EYE_SCREENING", localDate: "2025-09-09" },
        { catalogueEntryKey: "BLOOD_TEST", localDate: "2026-05-12" },
        { catalogueEntryKey: "FOOT_CHECK", localDate: "2026-09-14" },
      ],
      NOW,
    );
    expect(summary).toMatchObject({ version: "care-intervals-preview.1", asOf: "2026-10-14", dueCount: 1 });
    expect(summary.nudges.map((entry) => [entry.key, entry.status])).toEqual([
      ["EYE_SCREENING", "DUE"],
      ["BLOOD_TEST", "DUE_SOON"],
      ["FOOT_CHECK", "NOT_DUE"],
    ]);
    expect(nudge(summary, "EYE_SCREENING")).toMatchObject({ lastDoneOn: "2025-09-09", monthsSinceLastDone: 13, dueOn: "2026-09-09" });
  });
});
