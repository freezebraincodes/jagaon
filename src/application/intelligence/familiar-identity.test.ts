import { describe, expect, it } from "vitest";
import {
  FAMILIAR_IDENTITY_RULE_VERSION,
  familiarItemKeyFor,
  normaliseFamiliarLabel,
  resolveActivityIdentity,
  resolveIntakeIdentities,
} from "./familiar-identity";

describe("deterministic familiar-item identity", () => {
  it("normalises only Unicode form, surrounding whitespace and case", () => {
    expect(FAMILIAR_IDENTITY_RULE_VERSION).toBe("familiar-identity.v1");
    expect(normaliseFamiliarLabel("  Kaya Toast ")).toBe("kaya toast");
    expect(normaliseFamiliarLabel("Café")).toBe(normaliseFamiliarLabel("Café"));
    expect(normaliseFamiliarLabel("咖椰吐司")).toBe("咖椰吐司");
    expect(normaliseFamiliarLabel("kaya  toast")).not.toBe(normaliseFamiliarLabel("kaya toast"));
  });

  it("keeps similar but different labels and translations as separate identities", () => {
    const key = (label: string) => familiarItemKeyFor({ kind: "INTAKE_ITEM", label, itemKind: "FOOD" });
    expect(key("Kaya toast")).toBe(key("kaya toast "));
    expect(key("Kaya toast")).not.toBe(key("Kaya toast with egg"));
    expect(key("Porridge")).not.toBe(key("Plain porridge"));
    expect(key("Kaya toast")).not.toBe(key("咖椰吐司"));
    expect(key("Kaya toast")).not.toBe(familiarItemKeyFor({ kind: "INTAKE_ITEM", label: "Kaya toast", itemKind: "DRINK" }));
    expect(key("Kaya toast")).toMatch(/^fik-[0-9a-f]{32}$/);
  });

  it("separates activities by label and category", () => {
    const key = (label: string, activityCategory: string) =>
      familiarItemKeyFor({ kind: "ACTIVITY", label, activityCategory: activityCategory as never });
    expect(key("Chair yoga", "FLEXIBILITY_OR_MOBILITY")).not.toBe(key("Tai chi", "FLEXIBILITY_OR_MOBILITY"));
    expect(key("Walk", "WALKING")).not.toBe(key("Walk", "HOUSEHOLD_ACTIVITY"));
  });

  it("groups repeated items within one event and ignores unknown items", () => {
    const identities = resolveIntakeIdentities([
      { kind: "FOOD", label: "Kaya toast" },
      { kind: "UNKNOWN", label: "something" },
      { kind: "FOOD", label: "kaya toast" },
      { kind: "DRINK", label: "Kopi" },
    ]);
    expect(identities.map((identity) => [identity.normalisedLabel, identity.itemIndexes])).toEqual([
      ["kaya toast", [0, 2]],
      ["kopi", [3]],
    ]);
    expect(resolveActivityIdentity({ activityCategory: "WALKING", patientLabel: " Morning walk" }).normalisedLabel).toBe(
      "morning walk",
    );
  });
});
