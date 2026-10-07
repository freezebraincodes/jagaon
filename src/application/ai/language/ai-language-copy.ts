import { deepFreeze } from "@/application/deep-freeze";
import { AI_LOCALES, AI_ORGANISABLE_SECTIONS, GLOSS_KEYS, type AiLocale, type GlossKey } from "@/domain/ai";

/**
 * Packet 11B.6 approved bilingual language copy (spec Sections 6.5, 7, 9.2). Application-owned text: atom
 * joiners, count nouns, claim clauses, value-free glosses sent to the model, care-section intros and the
 * deterministic default shells. Immutable; any wording change needs a new revision.
 * ai-language-copy.11b.7 (observation ownership, owner instruction 2026-10-07, offline): adds `explainObservationVariants`, the
 * closed set of approved neutral observation templates the application composes on the AI path (the model no longer writes the
 * EXPLAIN observation). Variant 0 is always the unchanged `explainDefaults` wording (the deterministic fallback); variants 1..N
 * present each fact group as its own recorded statement — never a pairing, association, cause, chronology or earlier/recent label,
 * never a date called a reading, never an item called a note — with one/other forms by the group's fact count and a `next` form for
 * a group that follows another. Every other entry is unchanged.
 * Fix round 1 (controller ruling, still 11b.7, never used live): every item statement is a label-tolerant colon/list frame (a recorded
 * item is arbitrary patient text, possibly a verb phrase), and no zh variant uses 也 (a zh statement after another group is a
 * standalone colon frame, so a date is never paired with the values before it).
 * ai-language-copy.11b.8 (presentation correction P1/P3, owner instruction 2026-10-08, offline): every item template (the default and
 * each variant) names the supplied item as the person's own words ("in your own words" / "（您的原文）"); the observation composer puts
 * each item inside the locale quotation marks. Adds `careDraftNotices`, the fixed bilingual care-draft copy (questions shown in the
 * person's own words and not carried out; the draft is not sent or confirmed as reviewed), shown apart from patient facts and from the
 * approved limitation copy. Nothing here is sent to the model; every other entry is byte-identical to 11b.7.
 */
export const AI_LANGUAGE_COPY_REVISION = "ai-language-copy.11b.8";
export type DisplayUnit = "MMOL_L" | "MG_DL";
export type CountNounKey = "READINGS" | "RECORDS";
export type ExplainDefaultKey = "headline" | "values" | "dates" | "ranges" | "times" | "items" | "evidenceWithCount" | "evidenceWithoutCount";
/** The EXPLAIN observation fact groups, in planned order. */
export const OBSERVATION_GROUPS = Object.freeze(["values", "dates", "ranges", "times", "items"] as const);
export type ObservationGroup = (typeof OBSERVATION_GROUPS)[number];
/** One group's template by the group's fact count (one value, date, period, time or item; or more). */
export type ObservationCountForms = Readonly<{ one: string; other: string }>;
/** One approved observation variant: per group, its form as the first statement and as a statement after another group. */
export type ObservationVariant = Readonly<Record<ObservationGroup, Readonly<{ first: ObservationCountForms; next: ObservationCountForms }>>>;
type ByLocale<T = string> = Readonly<Record<AiLocale, T>>;
export type LanguageCopy = Readonly<{
  revision: string;
  unitDisplay: Readonly<Record<DisplayUnit, string>>;
  listJoin: ByLocale<Readonly<{ pair: string; serial: string; last: string }>>;
  rangeJoin: ByLocale;
  pairJoin: ByLocale;
  quotes: ByLocale<readonly [string, string]>;
  countNouns: Readonly<Record<CountNounKey, ByLocale<Readonly<{ one: string; other: string }>>>>;
  claimClauses: Readonly<Record<"COMPARABLE_SLOT_TREND" | "FAMILIAR_OR_FREQUENT_ITEM", ByLocale>>;
  glosses: Readonly<Record<GlossKey, ByLocale>>;
  careIntros: Readonly<Record<string, ByLocale>>;
  explainDefaults: ByLocale<Readonly<Record<ExplainDefaultKey, string>>>;
  /** 11b.7: the approved non-default observation variants (1..N); the same count in both locales. */
  explainObservationVariants: ByLocale<readonly ObservationVariant[]>;
  tokenStandIn: ByLocale;
  /** 11b.8: fixed care-draft notices (application wording, never a patient fact or a limitation). */
  careDraftNotices: Readonly<{ questions: ByLocale; draft: ByLocale }>;
}>;

const CJK = /[㐀-鿿]/;
const REFERENCE = /\b(?:fact|claim|option|record|section|limitation)-/i;
const MARKERS: Readonly<Record<ExplainDefaultKey, string | null>> = { headline: "{meaning}", values: "{values}", dates: "{dates}", ranges: "{ranges}", times: "{times}", items: "{items}", evidenceWithCount: "{count}", evidenceWithoutCount: null };

function fail(code: string): never {
  throw new Error(code);
}
function checkText(text: string, locale: AiLocale) {
  if (/[0-9０-９]/.test(text)) fail("LANGUAGE_COPY_DIGIT");
  if (REFERENCE.test(text)) fail("LANGUAGE_COPY_REFERENCE");
  if (CJK.test(text) !== (locale === "zh-SG")) fail("LANGUAGE_COPY_LOCALE_MISMATCH");
}

export function buildLanguageCopy(copy: LanguageCopy): LanguageCopy {
  if (copy.revision !== AI_LANGUAGE_COPY_REVISION) fail("LANGUAGE_COPY_INVALID_REVISION");
  for (const locale of AI_LOCALES) {
    for (const family of Object.values(copy.claimClauses)) checkText(family[locale], locale);
    for (const key of GLOSS_KEYS) checkText(copy.glosses[key][locale], locale);
    for (const section of AI_ORGANISABLE_SECTIONS) {
      const intro = copy.careIntros[section]?.[locale];
      if (intro === undefined) fail("LANGUAGE_COPY_MISSING_ENTRY");
      checkText(intro, locale);
    }
    for (const noun of Object.values(copy.countNouns)) { checkText(noun[locale].one, locale); checkText(noun[locale].other, locale); }
    for (const [key, marker] of Object.entries(MARKERS) as Array<[ExplainDefaultKey, string | null]>) {
      const template = copy.explainDefaults[locale][key];
      if (marker !== null && template.split(marker).length !== 2) fail("LANGUAGE_COPY_TEMPLATE_INVALID");
      if (/\{(?!meaning\}|values\}|dates\}|ranges\}|times\}|items\}|count\})/.test(template)) fail("LANGUAGE_COPY_TEMPLATE_INVALID");
      checkText(template.replace(/\{[a-z]+\}/g, ""), locale);
    }
    checkText(copy.tokenStandIn[locale], locale);
    for (const notice of [copy.careDraftNotices?.questions?.[locale], copy.careDraftNotices?.draft?.[locale]]) {
      if (typeof notice !== "string" || notice.length === 0) fail("LANGUAGE_COPY_MISSING_ENTRY");
      checkText(notice, locale);
    }
    const variants = copy.explainObservationVariants[locale];
    if (!Array.isArray(variants) || variants.length === 0 || variants.length !== copy.explainObservationVariants[AI_LOCALES[0]].length) fail("LANGUAGE_COPY_TEMPLATE_INVALID");
    for (const variant of variants) {
      for (const group of OBSERVATION_GROUPS) {
        for (const position of ["first", "next"] as const) {
          for (const count of ["one", "other"] as const) {
            const template = variant[group]?.[position]?.[count];
            if (typeof template !== "string" || template.split(`{${group}}`).length !== 2 || /\{(?!values\}|dates\}|ranges\}|times\}|items\})/.test(template) || template.replace(`{${group}}`, "").includes("{")) fail("LANGUAGE_COPY_TEMPLATE_INVALID");
            checkText(template.replace(/\{[a-z]+\}/g, ""), locale);
          }
        }
      }
    }
  }
  return deepFreeze(structuredClone(copy)) as LanguageCopy;
}

const both = (en: string, zh: string): ByLocale => ({ "en-SG": en, "zh-SG": zh });

export const AI_LANGUAGE_COPY: LanguageCopy = buildLanguageCopy({
  revision: AI_LANGUAGE_COPY_REVISION,
  unitDisplay: { MMOL_L: "mmol/L", MG_DL: "mg/dL" },
  listJoin: { "en-SG": { pair: " and ", serial: ", ", last: " and " }, "zh-SG": { pair: " 和 ", serial: "、", last: " 和 " } },
  rangeJoin: { "en-SG": " to ", "zh-SG": "至" },
  pairJoin: { "en-SG": ", ", "zh-SG": "，" },
  quotes: { "en-SG": ["“", "”"], "zh-SG": ["“", "”"] },
  countNouns: {
    READINGS: { "en-SG": { one: "recorded reading", other: "recorded readings" }, "zh-SG": { one: "条记录读数", other: "条记录读数" } },
    RECORDS: { "en-SG": { one: "record", other: "records" }, "zh-SG": { one: "条记录", other: "条记录" } },
  },
  claimClauses: {
    COMPARABLE_SLOT_TREND: both("your readings from the same time slot in an earlier and a recent period", "同一时段在较早期间和近期的读数"),
    FAMILIAR_OR_FREQUENT_ITEM: both("how often the same recorded item or context appears in your records over a period", "同一个记录项目或情境在一段时间内出现在您记录中的次数"),
  },
  glosses: {
    MEANING_CLAUSE: both("what is being compared or counted, as a complete noun phrase", "比较或统计的内容（完整名词短语）"),
    RECORDED_VALUES: both("the recorded values with their units, as a complete noun phrase", "记录的数值及单位（完整名词短语）"),
    RECORDED_VALUE: both("one recorded value with its unit, as a complete noun phrase", "一个记录数值及单位（完整名词短语）"),
    EVIDENCE_COUNT: both("how many records this is based on, including the noun, as a complete noun phrase", "依据的记录数量，已含量词（完整名词短语）"),
    RECORDED_DATE: both("a recorded date, as a complete noun phrase", "一个记录日期（完整名词短语）"),
    RECORDED_DATE_RANGE: both("a recorded date range, as a complete noun phrase", "一个记录日期范围（完整名词短语）"),
    RECORDED_TIME: both("a recorded time of day, as a complete noun phrase", "一个记录时间（完整名词短语）"),
    RECORDED_ITEM: both("a recorded item name exactly as written, as a complete noun phrase", "按原文记录的项目名称（完整名词短语）"),
    APPOINTMENT_SERVICE: both("the name of an appointment service exactly as recorded", "按原文记录的预约服务名称"),
    PATIENT_QUESTION: both("a question the person wrote, already in quotation marks; do not answer or rephrase it", "本人写下的问题，已加引号；不要回答或改写"),
  },
  careIntros: {
    CURRENT_CARE_PLAN: both("Care plan details you chose to include:", "您选择加入的护理计划信息："),
    CARE_ORGANISATION: both("Appointment details you chose to include:", "您选择加入的预约信息："),
    MEASUREMENTS: both("Readings you chose to include:", "您选择加入的读数："),
    MEDICATION_RECORDS: both("Medication records you chose to include:", "您选择加入的药物记录："),
    SYMPTOMS_AND_CONTEXT: both("Notes and context you chose to include:", "您选择加入的备注和情境："),
    INTAKE_AND_ACTIVITY: both("Meals and activities you chose to include:", "您选择加入的饮食和活动："),
    PATTERNS: both("Patterns you chose to include:", "您选择加入的记录规律："),
    QUESTIONS_FOR_CARE_TEAM: both("Questions you want to ask:", "您想问的问题："),
  },
  explainDefaults: {
    "en-SG": { headline: "This looks at {meaning}.", values: "Recorded values: {values}.", dates: "Recorded dates: {dates}.", ranges: "Recorded period: {ranges}.", times: "Recorded times: {times}.", items: "Recorded items, in your own words: {items}.", evidenceWithCount: "This is based on {count}.", evidenceWithoutCount: "This is based on your recorded information." },
    "zh-SG": { headline: "这里看的是{meaning}。", values: "记录的数值：{values}。", dates: "记录的日期：{dates}。", ranges: "记录的期间：{ranges}。", times: "记录的时间：{times}。", items: "记录的项目（您的原文）：{items}。", evidenceWithCount: "以上内容基于{count}。", evidenceWithoutCount: "以上内容基于您的记录信息。" },
  },
  explainObservationVariants: {
    "en-SG": [
      {
        values: { first: { one: "Your records list {values}.", other: "Your records list {values}." }, next: { one: "Your records also list {values}.", other: "Your records also list {values}." } },
        dates: { first: { one: "Your records include an entry dated {dates}.", other: "Your records include entries dated {dates}." }, next: { one: "Your records also include an entry dated {dates}.", other: "Your records also include entries dated {dates}." } },
        ranges: { first: { one: "Your records include the period {ranges}.", other: "Your records include the periods {ranges}." }, next: { one: "Your records also include the period {ranges}.", other: "Your records also include the periods {ranges}." } },
        times: { first: { one: "Your records include an entry at {times}.", other: "Your records include entries at {times}." }, next: { one: "Your records also include an entry at {times}.", other: "Your records also include entries at {times}." } },
        items: { first: { one: "Item in your records, in your own words: {items}.", other: "Items in your records, in your own words: {items}." }, next: { one: "Also recorded, in your own words: {items}.", other: "Also recorded, in your own words: {items}." } },
      },
      {
        values: { first: { one: "The recorded value is {values}.", other: "The recorded values are {values}." }, next: { one: "The recorded value is {values}.", other: "The recorded values are {values}." } },
        dates: { first: { one: "The recorded date is {dates}.", other: "The recorded dates are {dates}." }, next: { one: "The recorded date is {dates}.", other: "The recorded dates are {dates}." } },
        ranges: { first: { one: "The recorded period is {ranges}.", other: "The recorded periods are {ranges}." }, next: { one: "The recorded period is {ranges}.", other: "The recorded periods are {ranges}." } },
        times: { first: { one: "The recorded time is {times}.", other: "The recorded times are {times}." }, next: { one: "The recorded time is {times}.", other: "The recorded times are {times}." } },
        items: { first: { one: "Item on record, in your own words: {items}.", other: "Items on record, in your own words: {items}." }, next: { one: "Other recorded item, in your own words: {items}.", other: "Other recorded items, in your own words: {items}." } },
      },
    ],
    "zh-SG": [
      {
        values: { first: { one: "您的记录中列出了{values}。", other: "您的记录中列出了{values}。" }, next: { one: "记录数值：{values}。", other: "记录数值：{values}。" } },
        dates: { first: { one: "您在{dates}有记录。", other: "您在{dates}都有记录。" }, next: { one: "记录日期：{dates}。", other: "记录日期：{dates}。" } },
        ranges: { first: { one: "您在{ranges}期间有记录。", other: "您在{ranges}期间都有记录。" }, next: { one: "记录期间：{ranges}。", other: "记录期间：{ranges}。" } },
        times: { first: { one: "您在{times}有记录。", other: "您在{times}都有记录。" }, next: { one: "记录时间：{times}。", other: "记录时间：{times}。" } },
        items: { first: { one: "记录项目（您的原文）：{items}。", other: "记录项目（您的原文）：{items}。" }, next: { one: "另外记录的项目（您的原文）：{items}。", other: "另外记录的项目（您的原文）：{items}。" } },
      },
      {
        values: { first: { one: "记录的数值为{values}。", other: "记录的数值为{values}。" }, next: { one: "记录的数值为{values}。", other: "记录的数值为{values}。" } },
        dates: { first: { one: "记录的日期为{dates}。", other: "记录的日期为{dates}。" }, next: { one: "记录的日期为{dates}。", other: "记录的日期为{dates}。" } },
        ranges: { first: { one: "记录的期间为{ranges}。", other: "记录的期间为{ranges}。" }, next: { one: "记录的期间为{ranges}。", other: "记录的期间为{ranges}。" } },
        times: { first: { one: "记录的时间为{times}。", other: "记录的时间为{times}。" }, next: { one: "记录的时间为{times}。", other: "记录的时间为{times}。" } },
        items: { first: { one: "您记录的项目（原文）：{items}。", other: "您记录的项目（原文）：{items}。" }, next: { one: "其他记录项目（您的原文）：{items}。", other: "其他记录项目（您的原文）：{items}。" } },
      },
    ],
  },
  tokenStandIn: both("the item", "该项"),
  careDraftNotices: {
    questions: both("Questions are shown in your own words; the app does not carry them out.", "问题按您的原话显示，应用不会照此执行。"),
    draft: both("The app does not send this draft to your care team or confirm that a clinician has reviewed it.", "应用不会把此草稿发送给护理团队，也不会确认医护人员已审阅。"),
  },
});
