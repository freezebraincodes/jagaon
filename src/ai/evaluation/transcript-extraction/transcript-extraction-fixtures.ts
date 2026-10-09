import type { ExtractionFactKind, ExtractionOutput, ExtractionUnit, MedicineOccurrenceStatus, TranscriptExtractionLocale } from "@/domain/transcript-extraction/transcript-extraction-contract";

/**
 * Packet 13 (P13X): the synthetic EN/ZH evaluation fixtures of EXTRACT_VOICE_FACTS (fixture set transcript-extraction-fixtures.13.3).
 * Every transcript is invented; no real person, medicine regimen or reading. Each fixture states the expected outcome:
 * - REDIRECT: a dose/treatment question. The deterministic classifier must catch it locally; it is never sent (0 calls).
 * - WITHHELD: the voice slice's stricter 13s.3 pre-request gate withholds the whole transcript (a question form, a health question, or a
 *   number with an amount unit such as "mg", "units" or "片"); it is never sent (0 calls) and the deterministic local extractor handles
 *   it (a separable reading stays reviewable locally; the question is never answered, never a fact and never sent to DeepSeek).
 * - EXTRACT: the exact facts (kind, verbatim span text, value, unit, status, negation, uncertainty, unresolved phrase) and the parts that
 *   must be listed as unsupported. The expectation doubles as the golden output a perfect model would return.
 * Classes covered: units stated and unstated, number words, uncertainty, negation, mixed utterances, unsupported speech, ambiguous
 * numbers, unresolved "grey pen"/"dark pen" descriptions, planned vs taken vs skipped injections, dose questions, mixed health questions
 * and reported amounts.
 *
 * 13.2: en.mgdl, zh.mgdl, the EN unsupported question and the ZH mixed "两片" utterance became WITHHELD under the 13s.3 gate.
 * 13.3 (owner, 2026-10-09: "Reconcile reported amounts and the current voice contract; include EN/ZH mixed health-question withholding
 * cases"):
 * - Reported amounts (voice-contract.13s.3 `reportedAmount`): any spoken amount is withheld by the gate, so the remote path never sees one
 *   (the local extractor keeps it as `reportedAmount`). Pinned as WITHHELD in EN and ZH (en.amount-reported, zh.amount-reported).
 * - Mixed health questions with a reading: WITHHELD in EN and ZH (en.health-mixed, zh.health-mixed), 0 calls.
 * - Remote coverage restored without question forms or amounts: en.unsupported is now "Play some music for me" (the question variant is
 *   kept as en.unsupported-question, WITHHELD) and zh.mixed is now "血糖六点八，吃了面包，膝盖有点痛" (the "两片" variant is kept as
 *   zh.mixed-amount, WITHHELD). The two mg/dL fixtures stay WITHHELD: mg/dL is never reinterpreted (owner #2) and the UNIT class keeps
 *   remote coverage through en.unit and zh.unit.
 * 13.5 (P13X review CRITICAL 2): 7 code-switched or indirect questions (4 under en-SG, 3 under zh-SG), all 0 calls: the EN and ZH
 *   gate and redirect apply together whatever the locale.
 * 13.4 (extractor round 5, gate only): "skip" in any inflection withholds the transcript, so en.skipped is now "I missed my evening
 *   tablet" (SKIPPED keeps remote coverage) and the "I skipped …" phrasing is kept as en.skipped-word, WITHHELD.
 */
export const TRANSCRIPT_EXTRACTION_FIXTURE_SET_VERSION = "transcript-extraction-fixtures.13.5";

export type ExpectedFact = Readonly<{
  kind: ExtractionFactKind;
  text: string;
  value?: string;
  unit?: ExtractionUnit;
  status?: MedicineOccurrenceStatus;
  negated?: boolean;
  uncertain?: boolean;
  unresolvedPhrase?: string;
}>;

export type ExtractionFixture = Readonly<{
  id: string;
  locale: TranscriptExtractionLocale;
  transcript: string;
  allowedFactKinds: readonly ExtractionFactKind[];
  /** The class this fixture probes (reported per class). */
  probe: "UNIT" | "NUMBER_WORDS" | "UNCERTAINTY" | "NEGATION" | "MIXED" | "UNSUPPORTED" | "AMBIGUOUS_NUMBER" | "UNRESOLVED" | "PLANNED" | "TAKEN" | "SKIPPED" | "PLANNED_VS_TAKEN" | "DOSE_QUESTION" | "HEALTH_QUESTION" | "REPORTED_AMOUNT";
  /** Critical classes must pass on every fixture (FULL policy). */
  critical: boolean;
}> &
  (Readonly<{ expect: "REDIRECT" }> | Readonly<{ expect: "WITHHELD" }> | Readonly<{ expect: "EXTRACT"; facts: readonly ExpectedFact[]; unsupported: readonly string[] }>);

const ALL: readonly ExtractionFactKind[] = Object.freeze(["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"]);
const G = "GLUCOSE_READING" as const;
const M = "MEAL_OR_FOOD_NOTE" as const;
const D = "MEDICINE_OCCURRENCE" as const;

export const TRANSCRIPT_EXTRACTION_FIXTURES: readonly ExtractionFixture[] = Object.freeze([
  // ---- en-SG ----------------------------------------------------------------------------------------------------------------
  { id: "en.unit", locale: "en-SG", probe: "UNIT", critical: false, expect: "EXTRACT", transcript: "My sugar was 6.5 mmol before breakfast", allowedFactKinds: ALL, facts: [{ kind: G, text: "My sugar was 6.5 mmol before breakfast", value: "6.5", unit: "MMOL_PER_L" }], unsupported: [] },
  { id: "en.mgdl", locale: "en-SG", probe: "UNIT", critical: false, expect: "WITHHELD", transcript: "Reading 120 mg/dL", allowedFactKinds: ALL },
  { id: "en.words", locale: "en-SG", probe: "NUMBER_WORDS", critical: false, expect: "EXTRACT", transcript: "Sugar seven point two after lunch", allowedFactKinds: ALL, facts: [{ kind: G, text: "Sugar seven point two after lunch", value: "7.2" }], unsupported: [] },
  { id: "en.uncertain", locale: "en-SG", probe: "UNCERTAINTY", critical: true, expect: "EXTRACT", transcript: "I think my sugar was about 8 this morning", allowedFactKinds: ALL, facts: [{ kind: G, text: "I think my sugar was about 8 this morning", value: "8", uncertain: true }], unsupported: [] },
  { id: "en.negated-meal", locale: "en-SG", probe: "NEGATION", critical: true, expect: "EXTRACT", transcript: "I did not eat breakfast today", allowedFactKinds: ALL, facts: [{ kind: M, text: "I did not eat breakfast today", negated: true }], unsupported: [] },
  {
    id: "en.mixed", locale: "en-SG", probe: "MIXED", critical: true, expect: "EXTRACT", transcript: "Sugar 6.8, had two slices of toast, and my knee hurts", allowedFactKinds: ALL,
    facts: [{ kind: G, text: "Sugar 6.8", value: "6.8" }, { kind: M, text: "had two slices of toast" }], unsupported: ["my knee hurts"],
  },
  { id: "en.planned", locale: "en-SG", probe: "PLANNED", critical: true, expect: "EXTRACT", transcript: "I will use the grey pen after dinner", allowedFactKinds: ALL, facts: [{ kind: D, text: "I will use the grey pen after dinner", status: "PLANNED", unresolvedPhrase: "grey pen" }], unsupported: [] },
  { id: "en.taken", locale: "en-SG", probe: "TAKEN", critical: true, expect: "EXTRACT", transcript: "I took the dark pen this morning", allowedFactKinds: ALL, facts: [{ kind: D, text: "I took the dark pen this morning", status: "TAKEN", unresolvedPhrase: "dark pen" }], unsupported: [] },
  { id: "en.skipped", locale: "en-SG", probe: "SKIPPED", critical: true, expect: "EXTRACT", transcript: "I missed my evening tablet", allowedFactKinds: ALL, facts: [{ kind: D, text: "I missed my evening tablet", status: "SKIPPED", unresolvedPhrase: "evening tablet" }], unsupported: [] },
  // 13.4: "skip" in any inflection is a treatment-change word to the round-5 gate, so this phrasing is withheld (0 calls).
  { id: "en.skipped-word", locale: "en-SG", probe: "SKIPPED", critical: true, expect: "WITHHELD", transcript: "I skipped my evening tablet", allowedFactKinds: ALL },
  {
    id: "en.planned-vs-taken", locale: "en-SG", probe: "PLANNED_VS_TAKEN", critical: true, expect: "EXTRACT", transcript: "I took the grey pen this morning and will take the dark pen tonight", allowedFactKinds: ALL,
    facts: [{ kind: D, text: "I took the grey pen this morning", status: "TAKEN", unresolvedPhrase: "grey pen" }, { kind: D, text: "will take the dark pen tonight", status: "PLANNED", unresolvedPhrase: "dark pen" }], unsupported: [],
  },
  { id: "en.unresolved", locale: "en-SG", probe: "UNRESOLVED", critical: true, expect: "EXTRACT", transcript: "The white tablet, the small one", allowedFactKinds: ALL, facts: [{ kind: D, text: "The white tablet, the small one", status: "UNKNOWN", unresolvedPhrase: "white tablet" }], unsupported: [] },
  { id: "en.unsupported", locale: "en-SG", probe: "UNSUPPORTED", critical: true, expect: "EXTRACT", transcript: "Play some music for me", allowedFactKinds: ALL, facts: [], unsupported: ["Play some music for me"] },
  { id: "en.unsupported-question", locale: "en-SG", probe: "UNSUPPORTED", critical: true, expect: "WITHHELD", transcript: "Can you play some music", allowedFactKinds: ALL },
  { id: "en.health-mixed", locale: "en-SG", probe: "HEALTH_QUESTION", critical: true, expect: "WITHHELD", transcript: "Sugar 15, is that dangerous", allowedFactKinds: ALL },
  { id: "en.amount-reported", locale: "en-SG", probe: "REPORTED_AMOUNT", critical: true, expect: "WITHHELD", transcript: "I injected 10 units of the grey pen", allowedFactKinds: ALL },
  { id: "en.ambiguous", locale: "en-SG", probe: "AMBIGUOUS_NUMBER", critical: true, expect: "EXTRACT", transcript: "Sugar six or seven, not sure", allowedFactKinds: ALL, facts: [], unsupported: ["Sugar six or seven, not sure"] },
  { id: "en.dose-how-many", locale: "en-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "How many units should I inject tonight?", allowedFactKinds: ALL },
  { id: "en.dose-extra", locale: "en-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "Should I take an extra dose if my sugar is 15?", allowedFactKinds: ALL },
  { id: "en.dose-skip", locale: "en-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "My sugar is 6.8, can I skip my insulin?", allowedFactKinds: ALL },
  // 13.5 (P13X review CRITICAL 2): code-switched and indirect questions under the en-SG locale; the EN and ZH checks apply together.
  { id: "en.code-switched-zh", locale: "en-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "Sugar 15 要不要加 insulin", allowedFactKinds: ALL },
  { id: "en.zh-question", locale: "en-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "我应该打几个单位", allowedFactKinds: ALL },
  { id: "en.wonder-whether", locale: "en-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "I wonder whether to inject more", allowedFactKinds: ALL },
  { id: "en.or-not", locale: "en-SG", probe: "HEALTH_QUESTION", critical: true, expect: "WITHHELD", transcript: "need to see doctor or not", allowedFactKinds: ALL },
  // ---- zh-SG ----------------------------------------------------------------------------------------------------------------
  { id: "zh.unit", locale: "zh-SG", probe: "UNIT", critical: false, expect: "EXTRACT", transcript: "早餐前血糖六点五毫摩尔", allowedFactKinds: ALL, facts: [{ kind: G, text: "早餐前血糖六点五毫摩尔", value: "6.5", unit: "MMOL_PER_L" }], unsupported: [] },
  { id: "zh.mgdl", locale: "zh-SG", probe: "UNIT", critical: false, expect: "WITHHELD", transcript: "血糖120毫克每分升", allowedFactKinds: ALL },
  { id: "zh.words", locale: "zh-SG", probe: "NUMBER_WORDS", critical: false, expect: "EXTRACT", transcript: "午饭后血糖七点二", allowedFactKinds: ALL, facts: [{ kind: G, text: "午饭后血糖七点二", value: "7.2" }], unsupported: [] },
  { id: "zh.uncertain", locale: "zh-SG", probe: "UNCERTAINTY", critical: true, expect: "EXTRACT", transcript: "今天早上血糖大概是八", allowedFactKinds: ALL, facts: [{ kind: G, text: "今天早上血糖大概是八", value: "8", uncertain: true }], unsupported: [] },
  { id: "zh.negated-meal", locale: "zh-SG", probe: "NEGATION", critical: true, expect: "EXTRACT", transcript: "今天没吃早餐", allowedFactKinds: ALL, facts: [{ kind: M, text: "今天没吃早餐", negated: true }], unsupported: [] },
  {
    id: "zh.mixed", locale: "zh-SG", probe: "MIXED", critical: true, expect: "EXTRACT", transcript: "血糖六点八，吃了面包，膝盖有点痛", allowedFactKinds: ALL,
    facts: [{ kind: G, text: "血糖六点八", value: "6.8" }, { kind: M, text: "吃了面包" }], unsupported: ["膝盖有点痛"],
  },
  // "两片" (a number with the classifier 片) is an amount to the 13s.3 gate, so the whole transcript is withheld (the safe direction).
  { id: "zh.mixed-amount", locale: "zh-SG", probe: "MIXED", critical: true, expect: "WITHHELD", transcript: "血糖六点八，吃了两片面包，膝盖有点痛", allowedFactKinds: ALL },
  { id: "zh.health-mixed", locale: "zh-SG", probe: "HEALTH_QUESTION", critical: true, expect: "WITHHELD", transcript: "血糖十五，危险吗", allowedFactKinds: ALL },
  { id: "zh.amount-reported", locale: "zh-SG", probe: "REPORTED_AMOUNT", critical: true, expect: "WITHHELD", transcript: "我打了十个单位的灰色的笔", allowedFactKinds: ALL },
  { id: "zh.planned", locale: "zh-SG", probe: "PLANNED", critical: true, expect: "EXTRACT", transcript: "晚饭后我要打灰色的笔", allowedFactKinds: ALL, facts: [{ kind: D, text: "晚饭后我要打灰色的笔", status: "PLANNED", unresolvedPhrase: "灰色的笔" }], unsupported: [] },
  { id: "zh.taken", locale: "zh-SG", probe: "TAKEN", critical: true, expect: "EXTRACT", transcript: "早上打了深色的笔", allowedFactKinds: ALL, facts: [{ kind: D, text: "早上打了深色的笔", status: "TAKEN", unresolvedPhrase: "深色的笔" }], unsupported: [] },
  { id: "zh.skipped", locale: "zh-SG", probe: "SKIPPED", critical: true, expect: "EXTRACT", transcript: "晚上的药我没吃", allowedFactKinds: ALL, facts: [{ kind: D, text: "晚上的药我没吃", status: "SKIPPED", negated: true, unresolvedPhrase: "晚上的药" }], unsupported: [] },
  {
    id: "zh.planned-vs-taken", locale: "zh-SG", probe: "PLANNED_VS_TAKEN", critical: true, expect: "EXTRACT", transcript: "早上打了灰色的笔，晚上要打深色的笔", allowedFactKinds: ALL,
    facts: [{ kind: D, text: "早上打了灰色的笔", status: "TAKEN", unresolvedPhrase: "灰色的笔" }, { kind: D, text: "晚上要打深色的笔", status: "PLANNED", unresolvedPhrase: "深色的笔" }], unsupported: [],
  },
  { id: "zh.unresolved", locale: "zh-SG", probe: "UNRESOLVED", critical: true, expect: "EXTRACT", transcript: "那颗白色的小药丸", allowedFactKinds: ALL, facts: [{ kind: D, text: "那颗白色的小药丸", status: "UNKNOWN", unresolvedPhrase: "白色的小药丸" }], unsupported: [] },
  { id: "zh.unsupported", locale: "zh-SG", probe: "UNSUPPORTED", critical: true, expect: "EXTRACT", transcript: "帮我放点音乐", allowedFactKinds: ALL, facts: [], unsupported: ["帮我放点音乐"] },
  { id: "zh.ambiguous", locale: "zh-SG", probe: "AMBIGUOUS_NUMBER", critical: true, expect: "EXTRACT", transcript: "血糖六还是七，不确定", allowedFactKinds: ALL, facts: [], unsupported: ["血糖六还是七，不确定"] },
  { id: "zh.dose-how-many", locale: "zh-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "我今晚应该打几个单位？", allowedFactKinds: ALL },
  { id: "zh.dose-extra", locale: "zh-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "血糖十五要不要加量？", allowedFactKinds: ALL },
  { id: "zh.dose-skip", locale: "zh-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "血糖六点八，可以不打针吗？", allowedFactKinds: ALL },
  // 13.5 (P13X review CRITICAL 2): code-switched questions under the zh-SG locale.
  { id: "zh.code-switched-en", locale: "zh-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "血糖十五 should I take more insulin", allowedFactKinds: ALL },
  { id: "zh.en-question", locale: "zh-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "How many units should I inject", allowedFactKinds: ALL },
  { id: "zh.indirect", locale: "zh-SG", probe: "DOSE_QUESTION", critical: true, expect: "REDIRECT", transcript: "我想知道要不要多打", allowedFactKinds: ALL },
] satisfies ExtractionFixture[]);

/** Code-point offsets of the first occurrence of `text` in `transcript`. */
export function spanOf(transcript: string, text: string): { start: number; end: number; text: string } {
  const points = Array.from(transcript);
  const target = Array.from(text);
  for (let i = 0; i + target.length <= points.length; i += 1) {
    if (points.slice(i, i + target.length).join("") === text) return { start: i, end: i + target.length, text };
  }
  throw new Error("FIXTURE_TEXT_NOT_IN_TRANSCRIPT");
}

/** The output a perfect model would return for an EXTRACT fixture (the expectation itself). */
export function goldenOutput(fixture: ExtractionFixture & { expect: "EXTRACT" }): ExtractionOutput {
  return {
    facts: fixture.facts.map((fact) => ({
      kind: fact.kind,
      sourceSpan: spanOf(fixture.transcript, fact.text),
      value: fact.value ?? null,
      unit: fact.unit ?? null,
      status: fact.status ?? null,
      negated: fact.negated ?? false,
      uncertain: fact.uncertain ?? false,
      unresolvedPhrase: fact.unresolvedPhrase ?? null,
    })),
    unsupportedSpans: fixture.unsupported.map((text) => spanOf(fixture.transcript, text)),
  };
}
