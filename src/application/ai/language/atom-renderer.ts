import { careSummaryLocalePack } from "@/application/care-preparation/care-summary-locale-pack";
import type { AiLocale } from "@/domain/ai";
import { AI_LANGUAGE_COPY, type CountNounKey, type DisplayUnit, type LanguageCopy } from "./ai-language-copy";

/**
 * Packet 11B.6 deterministic atom renderer (spec Section 6.5). The only producer of visible factual text in
 * a hybrid composition. Decimal values are the exact supplied strings (no Number, toFixed or Intl number
 * formatting); dates come only from the approved care-summary locale pack; text is verbatim.
 */
export const ATOM_RENDERER_VERSION = "ai-atoms.11b.6";

export type AtomSource =
  | { kind: "MEANING"; family: "COMPARABLE_SLOT_TREND" | "FAMILIAR_OR_FREQUENT_ITEM" }
  | { kind: "DECIMAL"; value: string; unit: string }
  | { kind: "DECIMAL_LIST"; values: ReadonlyArray<{ value: string; unit: string }> }
  | { kind: "COUNT"; value: number; noun: CountNounKey }
  | { kind: "DATE"; localDate: string }
  | { kind: "DATE_RANGE"; startDate: string; endDate: string }
  | { kind: "TIME"; localTime: string }
  | { kind: "LABEL"; text: string }
  | { kind: "QUOTED_TEXT"; text: string };

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

export function renderAtom(source: AtomSource, locale: AiLocale, copy: LanguageCopy = AI_LANGUAGE_COPY): string {
  switch (source.kind) {
    case "MEANING":
      return copy.claimClauses[source.family][locale];
    case "DECIMAL":
      return decimal(source.value, source.unit, copy);
    case "DECIMAL_LIST":
      return joinList(source.values.map((entry) => decimal(entry.value, entry.unit, copy)), locale, copy);
    case "COUNT": {
      const noun = copy.countNouns[source.noun][locale];
      return `${source.value} ${new Intl.PluralRules(locale).select(source.value) === "one" ? noun.one : noun.other}`;
    }
    case "DATE":
      return careSummaryLocalePack(locale).localDateText(source.localDate);
    case "DATE_RANGE": {
      const pack = careSummaryLocalePack(locale);
      return `${pack.localDateText(source.startDate)}${copy.rangeJoin[locale]}${pack.localDateText(source.endDate)}`;
    }
    case "TIME":
      return source.localTime;
    case "LABEL":
      return source.text;
    case "QUOTED_TEXT":
      return `${copy.quotes[locale][0]}${source.text}${copy.quotes[locale][1]}`;
  }
}
