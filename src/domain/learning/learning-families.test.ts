import { describe, expect, it } from "vitest";
import {
  LEARNING_FAMILIES,
  learningFamilySchema,
  LEARNED_KNOWLEDGE_LIFECYCLE_STATES,
  DAYS_OF_WEEK,
} from "./index";

describe("closed Learning family registry", () => {
  it("contains exactly the six approved families in order", () => {
    expect([...LEARNING_FAMILIES]).toEqual([
      "ROUTINE",
      "BEHAVIOUR",
      "PREFERENCE",
      "CONTEXT",
      "BARRIER",
      "FAMILIAR_ITEM",
    ]);
    expect(Object.isFrozen(LEARNING_FAMILIES)).toBe(true);
  });

  it("rejects unknown family identifiers", () => {
    expect(learningFamilySchema.safeParse("FAMILIAR_ITEM").success).toBe(true);
    for (const value of ["SLEEP", "familiar_item", "", "INSUFFICIENT"]) {
      expect(learningFamilySchema.safeParse(value).success).toBe(false);
    }
  });

  it("lists every persisted lifecycle state and never INSUFFICIENT", () => {
    expect([...LEARNED_KNOWLEDGE_LIFECYCLE_STATES]).toEqual([
      "EMERGING",
      "CANDIDATE",
      "ACTIVE",
      "WEAKENING",
      "STALE",
      "REJECTED",
      "ADOPTED",
    ]);
  });

  it("defines the seven days of the week", () => {
    expect([...DAYS_OF_WEEK]).toEqual([
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ]);
  });
});
