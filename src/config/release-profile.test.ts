import { describe, it, expect } from "vitest";
import {
  CURRENT_RELEASE_PROFILE,
  parseImplementedReleaseProfile,
} from "./release-profile";

describe("release profile", () => {
  it("locks this application to HACKATHON_DEMO", () => {
    expect(CURRENT_RELEASE_PROFILE).toBe("HACKATHON_DEMO");
  });

  it("accepts exactly HACKATHON_DEMO", () => {
    expect(parseImplementedReleaseProfile("HACKATHON_DEMO")).toBe(
      "HACKATHON_DEMO",
    );
  });

  it.each([
    "PATIENT_RELEASE",
    "IMPLEMENTATION_CHECKPOINT",
    "",
    undefined,
  ])("rejects unimplemented profile %s", (value) => {
    expect(() => parseImplementedReleaseProfile(value)).toThrow();
  });
});
