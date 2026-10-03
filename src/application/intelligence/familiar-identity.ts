import { canonicalizeJson } from "@/application/contracts/canonical-json";
import type { ActivityCategory } from "@/domain/health-records/activity-event";
import { sha256Hex } from "./metrics";

/**
 * Deterministic familiar-item identity rule ("familiar-identity.v1").
 *
 * Domain Sections 8.9 and 8.12: only meaning-preserving normalisation is
 * applied (Unicode NFC, surrounding whitespace and case). Synonyms,
 * translations, food classes and AI-proposed matches never share an
 * identity. The authored label stays in the source record.
 */

export const FAMILIAR_IDENTITY_RULE_VERSION = "familiar-identity.v1";

export function normaliseFamiliarLabel(label: string): string {
  return label.normalize("NFC").trim().toLowerCase();
}

export type FamiliarIdentityMaterial =
  | { kind: "INTAKE_ITEM"; label: string; itemKind: "FOOD" | "DRINK" | "OTHER" }
  | { kind: "ACTIVITY"; label: string; activityCategory: ActivityCategory };

/** Opaque patient-local key: never a catalogue identifier or display text. */
export function familiarItemKeyFor(material: FamiliarIdentityMaterial): string {
  const canonical =
    material.kind === "INTAKE_ITEM"
      ? { rule: FAMILIAR_IDENTITY_RULE_VERSION, kind: material.kind, label: normaliseFamiliarLabel(material.label), itemKind: material.itemKind }
      : {
          rule: FAMILIAR_IDENTITY_RULE_VERSION,
          kind: material.kind,
          label: normaliseFamiliarLabel(material.label),
          activityCategory: material.activityCategory,
        };
  return `fik-${sha256Hex(canonicalizeJson(canonical)).slice(0, 32)}`;
}

export type ResolvedIntakeIdentity = {
  familiarItemKey: string;
  normalisedLabel: string;
  itemKind: "FOOD" | "DRINK" | "OTHER";
  /** Zero-based positions in the exact source revision's `items` array. */
  itemIndexes: number[];
  /** Authored labels at those positions, unchanged. */
  authoredLabels: string[];
};

/** One identity per distinct item within an event; UNKNOWN items stay ineligible. */
export function resolveIntakeIdentities(
  items: readonly { kind: "FOOD" | "DRINK" | "OTHER" | "UNKNOWN"; label: string }[],
): ResolvedIntakeIdentity[] {
  const byKey = new Map<string, ResolvedIntakeIdentity>();
  items.forEach((item, index) => {
    if (item.kind === "UNKNOWN") return;
    const familiarItemKey = familiarItemKeyFor({ kind: "INTAKE_ITEM", label: item.label, itemKind: item.kind });
    const existing = byKey.get(familiarItemKey);
    if (existing) {
      existing.itemIndexes.push(index);
      existing.authoredLabels.push(item.label);
    } else {
      byKey.set(familiarItemKey, {
        familiarItemKey,
        normalisedLabel: normaliseFamiliarLabel(item.label),
        itemKind: item.kind,
        itemIndexes: [index],
        authoredLabels: [item.label],
      });
    }
  });
  return [...byKey.values()];
}

export type ResolvedActivityIdentity = {
  familiarItemKey: string;
  normalisedLabel: string;
  activityCategory: ActivityCategory;
  authoredLabel: string;
};

export function resolveActivityIdentity(activity: {
  activityCategory: ActivityCategory;
  patientLabel: string;
}): ResolvedActivityIdentity {
  return {
    familiarItemKey: familiarItemKeyFor({
      kind: "ACTIVITY",
      label: activity.patientLabel,
      activityCategory: activity.activityCategory,
    }),
    normalisedLabel: normaliseFamiliarLabel(activity.patientLabel),
    activityCategory: activity.activityCategory,
    authoredLabel: activity.patientLabel,
  };
}
