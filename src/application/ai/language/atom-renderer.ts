import { careSummaryLocalePack } from "@/application/care-preparation/care-summary-locale-pack";
import type { AiLocale } from "@/domain/ai";
import { COMPARISON_PERIOD_ROLES, COMPARISON_SLOTS, COMPARISON_SUMMARY_KINDS } from "@/domain/ai/ai-task-contracts";
import { AI_LANGUAGE_COPY, type ComparisonSlot, type CountNounKey, type DisplayUnit, type LanguageCopy } from "./ai-language-copy";

/**
 * Packet 11B.6 deterministic atom renderer (spec Section 6.5). The only producer of visible factual text in
 * a hybrid composition. Decimal values are the exact supplied strings (no Number, toFixed or Intl number
 * formatting); dates come only from the approved care-summary locale pack; text is verbatim.
 * Packet 11C (ai-language-copy.11b.9, 2026-10-08): the application-only PERIOD_SUMMARY atom of a source-backed EXPLAIN observation:
 * the slot label, then each period (EARLIER, then RECENT) with its dates (locale pack), its role-labelled summary value (median, or
 * interquartile range for VARIABILITY; the exact supplied string + mmol/L) and its exact count (READINGS noun, never capped). Never
 * projected to a model. The existing atom kinds render exactly as before.
 * ai-atoms.11b.7 (Packet 11C phase 2 version record, 2026-10-08, offline): the version moves for the Checkpoint 1 additions above, the
 * PERIOD_SUMMARY kind and its renderer-owned lead joiner (PERIOD_LEAD_JOIN). No rendering changed in this bump; every existing kind's
 * output is byte-identical to ai-atoms.11b.6.
 */
export const ATOM_RENDERER_VERSION = "ai-atoms.11b.7";

export type PeriodSummaryRole = (typeof COMPARISON_PERIOD_ROLES)[number];
export type PeriodSummaryKind = (typeof COMPARISON_SUMMARY_KINDS)[number];
export type PeriodSummaryPeriod = Readonly<{ role: PeriodSummaryRole; startDate: string; endDate: string; count: number; value: string }>;

export type AtomSource =
  | { kind: "MEANING"; family: "COMPARABLE_SLOT_TREND" | "FAMILIAR_OR_FREQUENT_ITEM" }
  | { kind: "DECIMAL"; value: string; unit: string }
  | { kind: "DECIMAL_LIST"; values: ReadonlyArray<{ value: string; unit: string }> }
  | { kind: "COUNT"; value: number; noun: CountNounKey }
  | { kind: "DATE"; localDate: string }
  | { kind: "DATE_RANGE"; startDate: string; endDate: string }
  | { kind: "TIME"; localTime: string }
  | { kind: "LABEL"; text: string }
  | { kind: "QUOTED_TEXT"; text: string }
  | { kind: "PERIOD_SUMMARY"; slot: ComparisonSlot; summaryKind: PeriodSummaryKind; periods: ReadonlyArray<PeriodSummaryPeriod> };

/** Joins the slot lead to the periods (a joiner, like the list and range joiners; not approved wording). */
const PERIOD_LEAD_JOIN: Readonly<Record<AiLocale, string>> = Object.freeze({ "en-SG": ": ", "zh-SG": "：" });

export const isDisplayUnit = (unit: string): unit is DisplayUnit => unit === "MMOL_L" || unit === "MG_DL";

function decimal(value: string, unit: string, copy: LanguageCopy): string {
  if (!isDisplayUnit(unit)) throw new Error("ATOM_UNSUPPORTED_UNIT");
  return `${value} ${copy.unitDisplay[unit]}`;
}

function joinList(parts: readonly string[], locale: AiLocale, copy: LanguageCopy): string {
  const join = copy.listJoin[locale];
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]}${join.pair}${parts[1]}`;
  return `${parts.slice(0, -1).join(join.serial)}${join.last}${parts[parts.length - 1]}`;
}

function count(value: number, noun: CountNounKey, locale: AiLocale, copy: LanguageCopy): string {
  const forms = copy.countNouns[noun][locale];
  return `${value} ${new Intl.PluralRules(locale).select(value) === "one" ? forms.one : forms.other}`;
}

function dateRange(startDate: string, endDate: string, locale: AiLocale, copy: LanguageCopy): string {
  const pack = careSummaryLocalePack(locale);
  return `${pack.localDateText(startDate)}${copy.rangeJoin[locale]}${pack.localDateText(endDate)}`;
}

/** Substitutes the markers in one pass with literal text: a substituted value is never rescanned and no `$` pattern is interpreted. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (marker: string, name: string) => (Object.hasOwn(values, name) ? values[name]! : marker));
}

function periodSummary(source: Extract<AtomSource, { kind: "PERIOD_SUMMARY" }>, locale: AiLocale, copy: LanguageCopy): string {
  const invalid = (): never => { throw new Error("ATOM_INVALID_PERIOD_SUMMARY"); };
  const periods = source.periods;
  if (!(COMPARISON_SLOTS as readonly string[]).includes(source.slot) || !(COMPARISON_SUMMARY_KINDS as readonly string[]).includes(source.summaryKind)) invalid();
  if (periods.length !== COMPARISON_PERIOD_ROLES.length || periods.some((period, index) => period.role !== COMPARISON_PERIOD_ROLES[index] || !Number.isSafeInteger(period.count) || period.count < 0)) invalid();
  const text = copy.periodSummary[locale];
  const lead = fill(text.lead, { slot: copy.comparisonSlotLabels[source.slot][locale] });
  const parts = periods.map((period) =>
    fill(text[source.summaryKind], {
      role: text.roles[period.role],
      range: dateRange(period.startDate, period.endDate, locale, copy),
      value: decimal(period.value, "MMOL_L", copy),
      count: count(period.count, "READINGS", locale, copy),
    }),
  );
  return `${lead}${PERIOD_LEAD_JOIN[locale]}${parts.join(text.join)}`;
}

export function renderAtom(source: AtomSource, locale: AiLocale, copy: LanguageCopy = AI_LANGUAGE_COPY): string {
  switch (source.kind) {
    case "MEANING":
      return copy.claimClauses[source.family][locale];
    case "DECIMAL":
      return decimal(source.value, source.unit, copy);
    case "DECIMAL_LIST":
      return joinList(source.values.map((entry) => decimal(entry.value, entry.unit, copy)), locale, copy);
    case "COUNT":
      return count(source.value, source.noun, locale, copy);
    case "DATE":
      return careSummaryLocalePack(locale).localDateText(source.localDate);
    case "DATE_RANGE":
      return dateRange(source.startDate, source.endDate, locale, copy);
    case "TIME":
      return source.localTime;
    case "LABEL":
      return source.text;
    case "QUOTED_TEXT":
      return `${copy.quotes[locale][0]}${source.text}${copy.quotes[locale][1]}`;
    case "PERIOD_SUMMARY":
      return periodSummary(source, locale, copy);
  }
}

/** Packet 11C (11b.9): the fixed line shown with a source-backed explanation: a median or an IQR is a summary value, not a reading. */
export function renderSummaryRoleNotice(locale: AiLocale, copy: LanguageCopy = AI_LANGUAGE_COPY): string {
  return copy.summaryRoleNotice[locale];
}
