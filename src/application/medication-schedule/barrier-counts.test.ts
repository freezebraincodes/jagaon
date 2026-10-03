import { describe, expect, it } from "vitest";
import { projectBarrierCounts, type CountableResponseInput, type MedicationEventHeadInput } from "./barrier-counts";

const ORDER = ["FORGOT", "ROUTINE_CHANGED", "AWAY_FROM_HOME", "ACCESS_DIFFICULTY", "SIDE_EFFECT_CONCERN"] as const;
const WINDOW = { startDate: "2026-09-20", endDate: "2026-10-03" };

function response(id: number, overrides: Partial<CountableResponseInput> = {}): CountableResponseInput {
  return {
    responseRecordId: `r${id}`,
    rawAnswerKind: "BOUNDED_CHOICE",
    optionKey: "ROUTINE_CHANGED",
    inquiryAnswersCurrentRevision: true,
    basisRevisionId: `e${id}-1`,
    basisRecordId: `e${id}`,
    occasion: { identity: `rx|night|2026-09-${String(20 + id).padStart(2, "0")}`, localDate: `2026-09-${String(20 + id).padStart(2, "0")}`, scheduledTime: "21:00", medicineName: "Nocturin pen (demo)" },
    ...overrides,
  };
}

const head = (id: number, state = "MISSED", revision = 1): MedicationEventHeadInput => ({ recordId: `e${id}`, headRevisionId: `e${id}-${revision}`, state, active: true });

describe("factual barrier counts", () => {
  it("counts distinct occasions of explicitly selected reviewed options with exact evidence", () => {
    const result = projectBarrierCounts({
      responses: [response(1), response(2), response(3, { optionKey: "AWAY_FROM_HOME" })],
      eventHeads: [head(1), head(2, "UNSURE"), head(3)],
      window: WINDOW,
      optionOrder: ORDER,
    });
    expect(result).toEqual({
      counts: [
        {
          optionKey: "ROUTINE_CHANGED",
          occasionCount: 2,
          evidence: [
            { localDate: "2026-09-21", scheduledTime: "21:00", medicineName: "Nocturin pen (demo)" },
            { localDate: "2026-09-22", scheduledTime: "21:00", medicineName: "Nocturin pen (demo)" },
          ],
        },
        { optionKey: "AWAY_FROM_HOME", occasionCount: 1, evidence: [{ localDate: "2026-09-23", scheduledTime: "21:00", medicineName: "Nocturin pen (demo)" }] },
      ],
      excludedCorrected: 0,
    });
  });

  it("never counts Something else, Not sure, Prefer not to say or a superseded answer revision", () => {
    const result = projectBarrierCounts({
      responses: [
        response(1, { rawAnswerKind: "SOMETHING_ELSE", optionKey: null }),
        response(2, { rawAnswerKind: "NOT_SURE", optionKey: null }),
        response(3, { rawAnswerKind: "PREFER_NOT_TO_SAY", optionKey: null }),
        response(4, { inquiryAnswersCurrentRevision: false }),
      ],
      eventHeads: [head(1), head(2), head(3), head(4)],
      window: WINDOW,
      optionOrder: ORDER,
    });
    expect(result).toEqual({ counts: [], excludedCorrected: 0 });
  });

  it("counts several answers about one occasion once", () => {
    const occasion = response(1).occasion;
    const result = projectBarrierCounts({
      responses: [response(1), response(2, { occasion, basisRecordId: "e1", basisRevisionId: "e1-1" })],
      eventHeads: [head(1)],
      window: WINDOW,
      optionOrder: ORDER,
    });
    expect(result.counts).toEqual([expect.objectContaining({ optionKey: "ROUTINE_CHANGED", occasionCount: 1 })]);
  });

  it("excludes an answer whose record was corrected to taken or deleted, and reports it", () => {
    const result = projectBarrierCounts({
      responses: [response(1), response(2), response(3)],
      eventHeads: [head(1, "TAKEN", 2), { ...head(2), active: false }, head(3)],
      window: WINDOW,
      optionOrder: ORDER,
    });
    expect(result.counts).toEqual([expect.objectContaining({ optionKey: "ROUTINE_CHANGED", occasionCount: 1 })]);
    expect(result.excludedCorrected).toBe(2);
  });

  it("ignores answers outside the displayed date window and is input-order independent", () => {
    const outside = response(1, { occasion: { ...response(1).occasion, localDate: "2026-09-01", identity: "rx|night|2026-09-01" } });
    const forward = projectBarrierCounts({ responses: [outside, response(2), response(3)], eventHeads: [head(1), head(2), head(3)], window: WINDOW, optionOrder: ORDER });
    const reversed = projectBarrierCounts({ responses: [response(3), response(2), outside], eventHeads: [head(3), head(2), head(1)], window: WINDOW, optionOrder: ORDER });
    expect(forward).toEqual(reversed);
    expect(forward.counts[0]!.occasionCount).toBe(2);
  });
});
