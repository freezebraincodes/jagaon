import { describe, expect, it } from "vitest";
import { DEMO_BOUNDARY_PLACEMENT } from "./demo-boundary-placement";

describe("demo boundary placement", () => {
  it("is hidden on every screen (owner decision 2026-10-12); the banner component and its wording are kept", () => {
    expect(DEMO_BOUNDARY_PLACEMENT).toBe("HIDDEN");
  });
});
