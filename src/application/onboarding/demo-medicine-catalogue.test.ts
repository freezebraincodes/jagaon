import { describe, expect, it } from "vitest";
import {
  DEMO_MEDICINE_CATALOGUE,
  findDemoCatalogueEntry,
  searchDemoMedicineCatalogue,
} from "./demo-medicine-catalogue";

describe("demo medicine catalogue", () => {
  it("contains exactly the three fictional display choices, frozen", () => {
    expect(DEMO_MEDICINE_CATALOGUE.map((entry) => entry.displayName)).toEqual([
      "Nocturin pen",
      "Veltora pen",
      "Glucotab",
    ]);
    expect(Object.isFrozen(DEMO_MEDICINE_CATALOGUE)).toBe(true);
    for (const entry of DEMO_MEDICINE_CATALOGUE) expect(Object.isFrozen(entry)).toBe(true);
  });

  it("maps only the exact governed generic identities to reviewed content", () => {
    expect(findDemoCatalogueEntry("nocturin-pen-demo")).toMatchObject({
      genericName: "insulin glargine",
      reviewedContentKey: "insulin-glargine",
      form: "PRE_FILLED_PEN",
    });
    expect(findDemoCatalogueEntry("veltora-pen-demo")).toMatchObject({
      genericName: "insulin aspart",
      reviewedContentKey: "insulin-aspart",
      form: "PRE_FILLED_PEN",
    });
    expect(findDemoCatalogueEntry("glucotab-demo")).toMatchObject({
      genericName: null,
      reviewedContentKey: null,
      form: "TABLET",
    });
    expect(findDemoCatalogueEntry("demo-glargine")).toBeNull();
  });

  it("never uses mockup-only labels as evidence", () => {
    const text = JSON.stringify(DEMO_MEDICINE_CATALOGUE);
    expect(text).not.toMatch(/demo-glargine|demo-aspart|\{reviewed/);
  });

  it("searches locally and case-insensitively by display or generic name", () => {
    expect(searchDemoMedicineCatalogue("").map((entry) => entry.key)).toHaveLength(3);
    expect(searchDemoMedicineCatalogue("  NOCTURIN ").map((entry) => entry.key)).toEqual([
      "nocturin-pen-demo",
    ]);
    expect(searchDemoMedicineCatalogue("aspart").map((entry) => entry.key)).toEqual([
      "veltora-pen-demo",
    ]);
    expect(searchDemoMedicineCatalogue("pen").map((entry) => entry.key)).toEqual([
      "nocturin-pen-demo",
      "veltora-pen-demo",
    ]);
    expect(searchDemoMedicineCatalogue("Oxatril (demo)")).toEqual([]);
  });

  it("carries no dose, schedule, indication or recommendation data", () => {
    for (const entry of DEMO_MEDICINE_CATALOGUE) {
      expect(Object.keys(entry).sort()).toEqual([
        "displayName",
        "form",
        "genericName",
        "key",
        "nameKind",
        "reviewedContentKey",
      ]);
    }
  });
});
