import { describe, it, expect } from "vitest";
import { metadata } from "./layout";

describe("layout metadata", () => {
  it("sets the exact truthful title", () => {
    expect(metadata.title).toBe("JagaOn | Your Everyday Care Companion");
  });

  it("sets the exact truthful description", () => {
    expect(metadata.description).toBe(
      "Synthetic-data hackathon prototype. Not for patient use.",
    );
  });
});
