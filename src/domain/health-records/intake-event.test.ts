import { describe, it, expect } from "vitest";
import {
  intakeEventPayloadSchema,
  INTAKE_EVENT_REVISION_ACTIONS,
} from "./intake-event";

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

function mkSnack() {
  return {
    intakeKind: "SNACK",
    occasion: "AD_HOC",
    foodIncluded: "YES",
    drinkIncluded: "NO",
    items: [{ kind: "FOOD", label: "Apple" }],
  };
}

function mkMeal() {
  return {
    intakeKind: "MEAL",
    occasion: "ROUTINE",
    foodIncluded: "YES",
    drinkIncluded: "UNKNOWN",
    items: [{ kind: "FOOD", label: "Rice and chicken" }],
  };
}

describe("intakeEventPayloadSchema", () => {
  it("accepts an ad-hoc snack with no reason and no slot", () => {
    const result = intakeEventPayloadSchema.parse(mkSnack());
    expect(result.intakeKind).toBe("SNACK");
    expect(result.reason).toBeUndefined();
    expect(result.intakeSlot).toBeUndefined();
  });

  it("accepts a meal with a standard breakfast slot", () => {
    const result = intakeEventPayloadSchema.parse({
      ...mkMeal(),
      intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" },
    });
    expect(result.intakeSlot!.kind).toBe("STANDARD_MEAL");
  });

  it("accepts a meal with standard lunch, dinner, and supper slots", () => {
    for (const code of ["LUNCH", "DINNER", "SUPPER"]) {
      const result = intakeEventPayloadSchema.parse({
        ...mkMeal(),
        intakeSlot: { kind: "STANDARD_MEAL", code },
      });
      expect(result.intakeSlot!.kind).toBe("STANDARD_MEAL");
    }
  });

  it("rejects a STANDARD_MEAL slot on a non-MEAL intake", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({
        ...mkSnack(),
        intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" },
      }),
    ).toThrow();
  });

  it("accepts a TEA with STANDARD_MEAL slot rejected", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({
      intakeKind: "TEA",
      occasion: "ROUTINE",
      foodIncluded: "UNKNOWN",
      drinkIncluded: "YES",
      items: [{ kind: "DRINK", label: "Tea" }],
        intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" },
      }),
    ).toThrow();
  });

  it("accepts a PATIENT_DEFINED slot on non-MEAL intake", () => {
    const result = intakeEventPayloadSchema.parse({
      intakeKind: "SNACK",
      occasion: "ROUTINE",
      foodIncluded: "YES",
      drinkIncluded: "NO",
      items: [{ kind: "FOOD", label: "Afternoon snack" }],
      intakeSlot: {
        kind: "PATIENT_DEFINED",
        slotKey: "afternoon-tea",
        label: { text: "Afternoon tea", language: "en-SG" },
      },
    });
    expect(result.intakeSlot!.kind).toBe("PATIENT_DEFINED");
  });

  it("preserves tea with unknown foodIncluded", () => {
    const result = intakeEventPayloadSchema.parse({
      intakeKind: "TEA",
      occasion: "ROUTINE",
      foodIncluded: "UNKNOWN",
      drinkIncluded: "YES",
      items: [{ kind: "DRINK", label: "Tea" }],
    });
    expect(result.foodIncluded).toBe("UNKNOWN");
    expect(result.drinkIncluded).toBe("YES");
  });

  it("preserves tea explicitly without food (foodIncluded NO)", () => {
    const result = intakeEventPayloadSchema.parse({
      intakeKind: "TEA",
      occasion: "ROUTINE",
      foodIncluded: "NO",
      drinkIncluded: "YES",
      items: [{ kind: "DRINK", label: "A cup of tea only" }],
    });
    expect(result.foodIncluded).toBe("NO");
  });

  it("preserves tea with food (foodIncluded YES)", () => {
    const result = intakeEventPayloadSchema.parse({
      intakeKind: "TEA",
      occasion: "ROUTINE",
      foodIncluded: "YES",
      drinkIncluded: "YES",
      items: [
        { kind: "DRINK", label: "Tea" },
        { kind: "FOOD", label: "Biscuits" },
      ],
    });
    expect(result.foodIncluded).toBe("YES");
  });

  it("keeps tea food states YES, NO, UNKNOWN distinct", () => {
    const states = ["YES", "NO", "UNKNOWN"] as const;
    for (const s of states) {
      const result = intakeEventPayloadSchema.parse({
        intakeKind: "TEA",
        occasion: "ROUTINE",
        foodIncluded: s,
        drinkIncluded: "YES",
        items: [{ kind: "DRINK", label: "Tea" }],
      });
      expect(result.foodIncluded).toBe(s);
    }
  });

  it("keeps absent reason absent rather than manufacturing unknown", () => {
    const result = intakeEventPayloadSchema.parse(mkSnack());
    expect(result.reason).toBeUndefined();
  });

  it("keeps absent slot absent rather than manufacturing from clock time", () => {
    const result = intakeEventPayloadSchema.parse({
      intakeKind: "MEAL",
      occasion: "ROUTINE",
      foodIncluded: "YES",
      drinkIncluded: "YES",
      items: [{ kind: "FOOD", label: "Lunch" }],
    });
    expect(result.intakeSlot).toBeUndefined();
  });

  it("accepts FEELING_UNWELL with a non-empty symptomRefs tuple", () => {
    const result = intakeEventPayloadSchema.parse({
      ...mkSnack(),
      reason: {
        kind: "FEELING_UNWELL",
        symptomRefs: [
          { recordType: "SYMPTOM_REPORT", recordId: UUID, revisionId: UUID },
        ],
      },
    });
    expect(result.reason!.kind).toBe("FEELING_UNWELL");
  });

  it("accepts FEELING_UNWELL with multiple symptomRefs", () => {
    const result = intakeEventPayloadSchema.parse({
      ...mkSnack(),
      reason: {
        kind: "FEELING_UNWELL",
        symptomRefs: [
          { recordType: "SYMPTOM_REPORT", recordId: UUID, revisionId: UUID },
          { recordType: "SYMPTOM_REPORT", recordId: UUID, revisionId: UUID },
        ],
      },
    });
    expect(result.reason!.kind).toBe("FEELING_UNWELL");
  });

  it("rejects FEELING_UNWELL with an empty symptomRefs array", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({
        ...mkSnack(),
        reason: {
          kind: "FEELING_UNWELL",
          symptomRefs: [],
        },
      }),
    ).toThrow();
  });

  it("accepts TREATING_KNOWN_OR_SUSPECTED_LOW reason", () => {
    const result = intakeEventPayloadSchema.parse({
      ...mkSnack(),
      reason: { kind: "TREATING_KNOWN_OR_SUSPECTED_LOW" },
    });
    expect(result.reason!.kind).toBe("TREATING_KNOWN_OR_SUSPECTED_LOW");
  });

  it("accepts a patient-defined slot with zh-SG label", () => {
    const result = intakeEventPayloadSchema.parse({
      intakeKind: "MEAL",
      occasion: "ROUTINE",
      foodIncluded: "YES",
      drinkIncluded: "NO",
      items: [{ kind: "FOOD", label: "Brunch" }],
      intakeSlot: {
        kind: "PATIENT_DEFINED",
        slotKey: "brunch",
        label: { text: "早午餐", language: "zh-SG" },
      },
    });
    expect(result.intakeSlot!.kind).toBe("PATIENT_DEFINED");
  });

  it("rejects leading/trailing whitespace on item labels", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({
        intakeKind: "SNACK",
        occasion: "AD_HOC",
        foodIncluded: "YES",
        drinkIncluded: "NO",
        items: [{ kind: "FOOD", label: "  Apple  " }],
      }),
    ).toThrow();
  });

  it("accepts an optional patientNote", () => {
    const result = intakeEventPayloadSchema.parse({
      ...mkSnack(),
      patientNote: { text: "Felt a bit hungry", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Felt a bit hungry");
  });

  it("rejects unknown keys on the payload", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({ ...mkSnack(), extra: true }),
    ).toThrow();
  });

  it("rejects unknown keys on an intake item", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({
        ...mkSnack(),
        items: [{ kind: "FOOD", label: "Apple", extra: true }],
      }),
    ).toThrow();
  });

  it("rejects an invalid intakeKind", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({ ...mkSnack(), intakeKind: "MEDICINE" }),
    ).toThrow();
  });

  it("rejects an invalid standard meal code", () => {
    expect(() =>
      intakeEventPayloadSchema.parse({
        ...mkMeal(),
        intakeSlot: { kind: "STANDARD_MEAL", code: "SNACK" },
      }),
    ).toThrow();
  });

  it("permits an empty items array (items may be unknown)", () => {
    const result = intakeEventPayloadSchema.parse({
      intakeKind: "DRINK",
      occasion: "AD_HOC",
      foodIncluded: "NO",
      drinkIncluded: "YES",
      items: [],
    });
    expect(result.items).toEqual([]);
  });
});

describe("INTAKE_EVENT_REVISION_ACTIONS", () => {
  it("has exactly CREATE, CORRECT, CONFIRM", () => {
    expect(INTAKE_EVENT_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
      "CONFIRM",
    ]);
  });

  it("does not include SYSTEM_DERIVE", () => {
    expect(INTAKE_EVENT_REVISION_ACTIONS).not.toContain("SYSTEM_DERIVE");
  });
});