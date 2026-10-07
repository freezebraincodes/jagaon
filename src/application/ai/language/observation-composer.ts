import { slotToken, slotTokenMatcher, type AiLocale, type AtomKind, type ShellFieldPath, type SlotPlan } from "@/domain/ai";
import { AI_LANGUAGE_COPY, OBSERVATION_GROUPS, type LanguageCopy, type ObservationGroup } from "./ai-language-copy";
import { countSentences, stripSlotTokens } from "./shell-validator";

/**
 * Observation ownership (owner instruction 2026-10-07, offline): the deterministic EXPLAIN_PATTERN observation composer. The
 * application, not the model, writes the observation: a local shell template over the plan's observation slots (each slot token
 * exactly once, in planned order), which the existing assembler then fills with the existing atoms.
 *
 * Variant 0 is today's approved default wording (`explainDefaults`, "Recorded values: …" / "记录的数值：…"): the deterministic
 * fallback always uses it, so every deterministic composition is byte-identical to before. Variants 1..N
 * (`explainObservationVariants`, ai-language-copy.11b.7) are used on the AI path; the variant is chosen deterministically from the
 * request (`selectObservationVariant`: FNV-1a 32-bit over the UTF-8 requestId, then 1 + hash mod N), so the same request always
 * gets the same observation. Each fact group (values, dates, ranges, times, items, in that order) is its own statement; several
 * slots of one group use the existing list joins. No variant ever links two groups.
 * P1 presentation correction (ai-language-copy.11b.8, owner instruction 2026-10-08, offline): every item token (supplied patient text)
 * is placed inside the locale quotation marks, in every variant including the default, so the item reads as the person's own words.
 * The atom itself is unchanged and is still substituted verbatim by the assembler.
 */
export const OBSERVATION_PATH: ShellFieldPath = "observation";
const GROUP_OF: Partial<Record<AtomKind, ObservationGroup>> = { DECIMAL_LIST: "values", DATE: "dates", DATE_RANGE: "ranges", TIME: "times", LABEL: "items" };

class ObservationCompositionError extends Error {
  constructor() { super("OBSERVATION_COMPOSITION_INVALID"); }
}
const invalid = (): never => { throw new ObservationCompositionError(); };

export function joinTokens(tokens: readonly string[], join: Readonly<{ pair: string; serial: string; last: string }>): string {
  if (tokens.length <= 1) return tokens[0] ?? "";
  if (tokens.length === 2) return `${tokens[0]}${join.pair}${tokens[1]}`;
  return `${tokens.slice(0, -1).join(join.serial)}${join.last}${tokens[tokens.length - 1]}`;
}

/** The number of approved non-default variants (variants 1..N) in a locale. */
export function observationVariantCount(locale: AiLocale, copy: LanguageCopy = AI_LANGUAGE_COPY): number {
  return copy.explainObservationVariants[locale].length;
}

/** FNV-1a 32-bit over the UTF-8 bytes of a string. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

/** The AI-path variant of a request: deterministic from its requestId, always 1..N (never the default variant 0). */
export function selectObservationVariant(requestId: string, locale: AiLocale, copy: LanguageCopy = AI_LANGUAGE_COPY): number {
  return 1 + (fnv1a32(requestId) % observationVariantCount(locale, copy));
}

/**
 * The observation shell (with slot tokens) of an EXPLAIN plan in the given variant: 0 = the default wording, 1..N = the approved
 * variants. Throws OBSERVATION_COMPOSITION_INVALID for a plan without an observation field, an unknown variant, or a template that
 * does not carry exactly the plan's observation slots in planned order.
 */
export function composeObservationShell(plan: SlotPlan, variant: number, copy: LanguageCopy = AI_LANGUAGE_COPY): string {
  const field = plan.fields.find((entry) => entry.path === OBSERVATION_PATH) ?? invalid();
  if (plan.taskType !== "EXPLAIN_PATTERN" || !Number.isInteger(variant) || variant < 0 || variant > observationVariantCount(plan.locale, copy)) invalid();
  const locale = plan.locale;
  const slots = plan.slots.filter((slot) => slot.homeField === OBSERVATION_PATH);
  const present = OBSERVATION_GROUPS.flatMap((group) => {
    const members = slots.filter((slot) => GROUP_OF[slot.atomKind] === group);
    if (members.length === 0) return [];
    // The group's fact count: the values of the one DECIMAL_LIST slot, else one fact per slot.
    const facts = group === "values" ? members.reduce((sum, slot) => sum + slot.boundRefs.length, 0) : members.length;
    const [open, close] = copy.quotes[locale];
    const tokens = members.map((slot) => (group === "items" ? `${open}${slotToken(slot.slotId)}${close}` : slotToken(slot.slotId)));
    return [{ group, tokens, facts }];
  });
  if (present.reduce((sum, entry) => sum + entry.tokens.length, 0) !== slots.length) invalid();
  const sentences = present.map(({ group, tokens, facts }, index) => {
    const joined = joinTokens(tokens, copy.listJoin[locale]);
    if (variant === 0) return copy.explainDefaults[locale][group].replace(`{${group}}`, joined);
    const forms = copy.explainObservationVariants[locale][variant - 1]![group][index === 0 ? "first" : "next"];
    return (facts === 1 ? forms.one : forms.other).replace(`{${group}}`, joined);
  });
  const text = sentences.join(locale === "en-SG" ? " " : "");
  const found = [...text.matchAll(slotTokenMatcher())].map((match) => match[1]);
  if (found.join("|") !== field.requiredSlots.join("|")) invalid();
  return text;
}

/**
 * The application-owned (LOCAL) field shells of a plan for the AI path: today only the EXPLAIN observation in the given variant.
 * The text outside the tokens must fit the field's fixed budget (code points and sentences) and carry language. A care plan has no
 * local field (empty map). Any failure throws OBSERVATION_COMPOSITION_INVALID (an assembly invariant failure, never bypassed).
 */
export function composeLocalShells(plan: SlotPlan, variant: number, copy: LanguageCopy = AI_LANGUAGE_COPY): ReadonlyMap<ShellFieldPath, string> {
  const local = plan.fields.filter((field) => field.owner === "LOCAL");
  const shells = new Map<ShellFieldPath, string>();
  for (const field of local) {
    if (field.path !== OBSERVATION_PATH) invalid();
    const text = composeObservationShell(plan, variant, copy);
    const prose = stripSlotTokens(text, "").trim();
    if ([...prose].length > field.maxCodePoints || countSentences(prose) > field.maxSentences || prose.replace(/[\s\p{P}]/gu, "").length === 0) invalid();
    shells.set(field.path, text);
  }
  return shells;
}

export const isObservationCompositionError = (error: unknown): boolean => error instanceof ObservationCompositionError;
