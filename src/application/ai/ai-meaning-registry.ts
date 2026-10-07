import { AI_LOCALES, EXPLAINABLE_PATTERN_FAMILIES, EXPLANATION_LIMITATION_CODES, type AiLocale } from "@/domain/ai/ai-task-contracts";

/**
 * Packet 11B.5 approved-meaning registry (Option B; owner approval
 * 2026-10-05 of internal-docs/implementation-plans/11-approved-meaning-review-matrix.md
 * §13). Approval covers the synthetic hackathon scope only: it is not clinical
 * validation or independent professional linguistic certification.
 *
 * Two entry kinds, keyed by (task, kind, code, locale):
 * - CLAIM_FAMILY_MEANING: provider-facing. The projector places it in the
 *   detached payload as `claim.approvedMeaning`; it is never shown to the
 *   patient and the model never infers meaning from the family code.
 * - LIMITATION_TEXT: patient-facing fixed copy. The application renders it in
 *   the accepted result and the deterministic fallback; it never reaches the
 *   model.
 *
 * Codes without an approved row stay in the domain type but have no entry, so
 * a request carrying one falls back before any provider call. The registry is
 * immutable; changing any row requires a new revision.
 */

export const AI_MEANING_REGISTRY_REVISION = "ai-meaning-registry.11b.1";

export type MeaningEntryKind = "CLAIM_FAMILY_MEANING" | "LIMITATION_TEXT";
export type MeaningRegistryEntry = Readonly<{ task: "EXPLAIN_PATTERN"; kind: MeaningEntryKind; code: string; locale: AiLocale; text: string }>;
export type AiMeaningRegistry = Readonly<{ revision: string; entries: readonly MeaningRegistryEntry[] }>;

const NON_CAUSAL_CODE = "DOES_NOT_ESTABLISH_CAUSE";
const REVISION = /^ai-meaning-registry\.\d{1,3}[a-z]?\.\d{1,3}$/;
const CJK = /[㐀-鿿]/;
const KNOWN: Readonly<Record<MeaningEntryKind, readonly string[]>> = { CLAIM_FAMILY_MEANING: EXPLAINABLE_PATTERN_FAMILIES, LIMITATION_TEXT: EXPLANATION_LIMITATION_CODES };

function invalid(code: string): never {
  throw new Error(code);
}

/** Validates and freezes a registry; any malformed, unknown, duplicate, unpaired or cross-locale entry throws a closed code. */
export function buildMeaningRegistry(revision: string, entries: readonly MeaningRegistryEntry[]): AiMeaningRegistry {
  if (!REVISION.test(revision)) invalid("MEANING_REGISTRY_INVALID_REVISION");
  const keys = new Set<string>();
  for (const entry of entries) {
    if (entry.task !== "EXPLAIN_PATTERN" || !(entry.kind in KNOWN) || !(AI_LOCALES as readonly string[]).includes(entry.locale) || typeof entry.text !== "string" || entry.text.trim().length === 0) invalid("MEANING_REGISTRY_INVALID_ENTRY");
    if (!KNOWN[entry.kind].includes(entry.code)) invalid("MEANING_REGISTRY_UNKNOWN_CODE");
    if (CJK.test(entry.text) !== (entry.locale === "zh-SG")) invalid("MEANING_REGISTRY_LOCALE_MISMATCH");
    const key = `${entry.task}|${entry.kind}|${entry.code}|${entry.locale}`;
    if (keys.has(key)) invalid("MEANING_REGISTRY_DUPLICATE_KEY");
    keys.add(key);
  }
  for (const entry of entries) for (const locale of AI_LOCALES) if (!keys.has(`${entry.task}|${entry.kind}|${entry.code}|${locale}`)) invalid("MEANING_REGISTRY_MISSING_LOCALE");
  return Object.freeze({ revision, entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))) });
}

const row = (kind: MeaningEntryKind, code: string, en: string, zh: string): MeaningRegistryEntry[] => [
  { task: "EXPLAIN_PATTERN", kind, code, locale: "en-SG", text: en },
  { task: "EXPLAIN_PATTERN", kind, code, locale: "zh-SG", text: zh },
];

export const AI_MEANING_REGISTRY: AiMeaningRegistry = buildMeaningRegistry(AI_MEANING_REGISTRY_REVISION, [
  ...row("CLAIM_FAMILY_MEANING", "COMPARABLE_SLOT_TREND", "This compares readings from the same recorded slot across an earlier period and a recent period.", "这比较了同一记录时段在较早期间和近期记录的读数。"),
  ...row("CLAIM_FAMILY_MEANING", "FAMILIAR_OR_FREQUENT_ITEM", "This counts how often the same recorded item or context appears in your records over a period.", "这统计同一个记录项目或情境在一段时间内出现在您记录中的次数。"),
  // Reuses the approved Packet 7A history copy `history.nonCausalLimitation` verbatim.
  ...row("LIMITATION_TEXT", NON_CAUSAL_CODE, "This describes your records; it does not explain the cause.", "这只描述您的记录；并不解释原因。"),
  ...row("LIMITATION_TEXT", "SPARSE_RECORDING", "Only a small number of records were available for this.", "这里可用的记录数量较少。"),
  // A separate meaning from the non-causal limitation: missing records are not evidence of absence.
  ...row("LIMITATION_TEXT", "UNKNOWN_NEGATIVE_STATUS", "If something was not recorded, these records cannot show whether it happened.", "没有记录的事情，这些记录无法说明它是否发生过。"),
]);

function lookup(kind: MeaningEntryKind, code: string, locale: AiLocale, registry: AiMeaningRegistry): string | null {
  return registry.entries.find((entry) => entry.kind === kind && entry.code === code && entry.locale === locale)?.text ?? null;
}

/** The provider-facing approved meaning of a claim family, or null when none is approved. */
export function approvedClaimMeaning(family: string, locale: AiLocale, registry: AiMeaningRegistry = AI_MEANING_REGISTRY): string | null {
  return lookup("CLAIM_FAMILY_MEANING", family, locale, registry);
}

/** The patient-facing approved limitation text, or null when none is approved. */
export function approvedLimitationText(code: string, locale: AiLocale, registry: AiMeaningRegistry = AI_MEANING_REGISTRY): string | null {
  return lookup("LIMITATION_TEXT", code, locale, registry);
}

export type RenderedLimitation = Readonly<{ limitationRef: string; code: string; text: string }>;
export type RenderedLimitations = Readonly<{ complete: boolean; limitations: readonly RenderedLimitation[] }>;

/**
 * Application rendering of limitation copy, shared by the accepted result and
 * the deterministic fallback so both show identical text. Each code renders
 * once, in supplied order. The non-causal limitation is omitted when the fixed
 * `ai.pattern.limitation` row is also shown, so that meaning appears exactly
 * once. A code without approved text is never invented: `complete` is false.
 */
export function renderExplainLimitations(
  limitations: ReadonlyArray<{ ref: string; code: string }>,
  locale: AiLocale,
  options: { fixedNonCausalRowShown?: boolean; registry?: AiMeaningRegistry } = {},
): RenderedLimitations {
  const registry = options.registry ?? AI_MEANING_REGISTRY;
  const seenTexts = new Set<string>();
  const rendered: RenderedLimitation[] = [];
  let complete = true;
  for (const limitation of limitations) {
    const text = approvedLimitationText(limitation.code, locale, registry);
    if (text === null) {
      complete = false;
      continue;
    }
    if ((limitation.code === NON_CAUSAL_CODE && options.fixedNonCausalRowShown) || seenTexts.has(text)) continue;
    seenTexts.add(text);
    rendered.push(Object.freeze({ limitationRef: limitation.ref, code: limitation.code, text }));
  }
  return Object.freeze({ complete, limitations: Object.freeze(rendered) });
}
