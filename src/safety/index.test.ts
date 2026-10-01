import { describe, expect, it } from "vitest";
import * as safety from "./index";

import type { DecimalComparison } from "./index";

describe("Safety evaluator barrel", () => {
  it("exports exactly the approved Packet 5A runtime surface", () => {
    expect(Object.keys(safety).sort()).toEqual([
      "compareDecimalStrings",
      "evaluateHealthHubHypoglycaemiaDemo",
      "resolveHealthHubHypoglycaemiaDemoMessage",
    ]);
  });

  it("exports the comparison type", () => {
    const comparison: DecimalComparison = 0;
    expect(comparison).toBe(0);
  });
});
