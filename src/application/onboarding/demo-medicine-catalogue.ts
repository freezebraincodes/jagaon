/**
 * Closed, frozen catalogue of demo medicines for Packet 6A. Owner decision 2026-10-14: the two insulin pens use the real brand names
 * Lantus (insulin glargine) and Apidra (insulin glulisine) in place of the fictional Nocturin and Veltora pens; the demo person, her
 * directions and her records stay synthetic.
 *
 * Search is local and case-insensitive; nothing calls an external service.
 * A fictional display brand points to reviewed general information only
 * when it carries an approved governed content key AND the matching generic
 * identity is visible. Entries carry no dose, schedule or indication data.
 */

export type DemoReviewedContentKey = "insulin-glargine" | "insulin-glulisine";

export type DemoCatalogueKey = "lantus-demo" | "apidra-demo" | "glucotab-demo";

export type DemoMedicineForm = "PRE_FILLED_PEN" | "TABLET";

export type DemoCatalogueEntry = {
  key: DemoCatalogueKey;
  displayName: string;
  /** Whether the display name is a brand name or a generic name. */
  nameKind: "BRAND" | "GENERIC";
  /** Visible generic identity; must match the reviewed content key. */
  genericName: "insulin glargine" | "insulin glulisine" | null;
  form: DemoMedicineForm;
  reviewedContentKey: DemoReviewedContentKey | null;
};

export const DEMO_MEDICINE_CATALOGUE: readonly DemoCatalogueEntry[] = Object.freeze([
  Object.freeze({
    key: "lantus-demo",
    displayName: "Lantus",
    nameKind: "BRAND",
    genericName: "insulin glargine",
    form: "PRE_FILLED_PEN",
    reviewedContentKey: "insulin-glargine",
  } as const),
  Object.freeze({
    key: "apidra-demo",
    displayName: "Apidra",
    nameKind: "BRAND",
    genericName: "insulin glulisine",
    form: "PRE_FILLED_PEN",
    reviewedContentKey: "insulin-glulisine",
  } as const),
  Object.freeze({
    key: "glucotab-demo",
    displayName: "Glucotab",
    nameKind: "GENERIC",
    genericName: null,
    form: "TABLET",
    reviewedContentKey: null,
  } as const),
]);

export const DEMO_CATALOGUE_KEYS: readonly DemoCatalogueKey[] = Object.freeze(
  DEMO_MEDICINE_CATALOGUE.map((entry) => entry.key),
);

export function findDemoCatalogueEntry(key: string | null): DemoCatalogueEntry | null {
  return DEMO_MEDICINE_CATALOGUE.find((entry) => entry.key === key) ?? null;
}

/** Local, case-insensitive filter; an empty query lists every entry. */
export function searchDemoMedicineCatalogue(query: string): DemoCatalogueEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...DEMO_MEDICINE_CATALOGUE];
  return DEMO_MEDICINE_CATALOGUE.filter(
    (entry) =>
      entry.displayName.toLowerCase().includes(needle) ||
      (entry.genericName?.toLowerCase().includes(needle) ?? false),
  );
}
