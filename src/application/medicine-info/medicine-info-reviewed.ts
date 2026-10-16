import { DEMO_MEDICINE_CATALOGUE, type DemoReviewedContentKey } from "@/application/onboarding/demo-medicine-catalogue";
import { normaliseMedicineInfoName } from "@/domain/medicine-info/medicine-info-contract";

/**
 * HSA preview (owner decision 2026-10-14): the reviewed HealthHub content key for a spoken or written medicine name, or null. Exact
 * names only (case and spacing ignored): a demo catalogue display name ("Lantus", "Apidra"), its generic name ("insulin glargine") or
 * the generic's own word ("glargine"). A medicine with a key keeps showing its reviewed card; the AI lookup is offered only without one.
 */
export function reviewedMedicineKeyFor(name: string): DemoReviewedContentKey | null {
  const wanted = normaliseMedicineInfoName(name);
  if (wanted.length === 0) return null;
  for (const entry of DEMO_MEDICINE_CATALOGUE) {
    if (entry.reviewedContentKey === null) continue;
    const names = [entry.displayName, ...(entry.genericName ? [entry.genericName, entry.genericName.replace(/^insulin\s+/, "")] : [])];
    if (names.some((candidate) => normaliseMedicineInfoName(candidate) === wanted)) return entry.reviewedContentKey;
  }
  return null;
}
