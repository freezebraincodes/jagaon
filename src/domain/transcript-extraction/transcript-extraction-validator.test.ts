// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ExtractionFact, ExtractionRequest } from "./transcript-extraction-contract";
import { spokenNumbers } from "./transcript-extraction-lexicon";
import { validateExtraction, type ExtractionRejectionReason } from "./transcript-extraction-validator";

/** Packet 13 (P13X): the extraction r-rules. Every model output is untrusted; a rejection means the deterministic local fallback. */

const noRedirect = () => false;

function request(transcript: string, locale: "en-SG" | "zh-SG" = "en-SG", allowedFactKinds: ExtractionRequest["allowedFactKinds"] = ["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"]): ExtractionRequest {
  return { taskType: "EXTRACT_VOICE_FACTS", contractVersion: "transcript-extraction.13.1", locale, transcript, allowedFactKinds };
}

/** A fact whose span is the first occurrence of `text` in the transcript (code-point offsets). */
function fact(transcript: string, text: string, patch: Partial<ExtractionFact> = {}): ExtractionFact {
  const points = Array.from(transcript);
  const target = Array.from(text);
  let start = -1;
  for (let i = 0; i + target.length <= points.length; i += 1) if (points.slice(i, i + target.length).join("") === text) { start = i; break; }
  if (start < 0) throw new Error(`not in transcript: ${text}`);
  return { kind: "GLUCOSE_READING", sourceSpan: { start, end: start + target.length, text }, value: null, unit: null, status: null, negated: false, uncertain: false, unresolvedPhrase: null, ...patch };
}

function check(transcript: string, facts: ExtractionFact[], unsupported: ExtractionFact["sourceSpan"][] = [], locale: "en-SG" | "zh-SG" = "en-SG", redirect: (text: string) => boolean = noRedirect) {
  return validateExtraction(request(transcript, locale), { facts, unsupportedSpans: unsupported }, { isRedirect: redirect });
}
const reason = (result: ReturnType<typeof check>): ExtractionRejectionReason | null => (result.kind === "REJECTED" ? result.reason : null);

describe("spoken numbers", () => {
  it("reads digits, full-width digits, English and Chinese number words", () => {
    expect(spokenNumbers("six point five")).toEqual(["6.5"]);
    expect(spokenNumbers("twelve units and 6.50")).toEqual(["6.5", "12"]);
    expect(spokenNumbers("one hundred and twenty")).toEqual(["120"]);
    expect(spokenNumbers("血糖六点五")).toEqual(["6.5"]);
    expect(spokenNumbers("打了十二个单位")).toEqual(["12"]);
    expect(spokenNumbers("１０单位")).toEqual(["10"]);
  });
});

describe("Packet 13 extraction validator: accepted controls", () => {
  it("accepts a glucose reading whose value and unit are in the span", () => {
    const t = "My sugar was 6.5 mmol before breakfast";
    expect(check(t, [fact(t, "My sugar was 6.5 mmol before breakfast", { value: "6.5", unit: "MMOL_PER_L" })])).toMatchObject({ kind: "VALID" });
  });

  it("accepts a planned injection and a taken one, a skipped dose with negation, and an unresolved pen phrase kept verbatim", () => {
    const t = "I took my grey pen 10 units, and I will use the dark pen tonight";
    const result = check(t, [
      fact(t, "I took my grey pen 10 units", { kind: "MEDICINE_OCCURRENCE", value: "10", unit: "UNITS", status: "TAKEN", unresolvedPhrase: "grey pen" }),
      fact(t, "I will use the dark pen tonight", { kind: "MEDICINE_OCCURRENCE", status: "PLANNED", unresolvedPhrase: "dark pen" }),
    ]);
    expect(result).toMatchObject({ kind: "VALID" });
    const z = "我今天没打针";
    expect(check(z, [fact(z, "我今天没打针", { kind: "MEDICINE_OCCURRENCE", status: "SKIPPED", negated: true })], [], "zh-SG")).toMatchObject({ kind: "VALID" });
  });

  it("accepts a meal note, uncertainty kept, and an unsupported part listed instead of dropped", () => {
    const t = "Maybe 7.2 after lunch, had chicken rice, and my knee hurts";
    expect(
      check(t, [fact(t, "Maybe 7.2 after lunch", { value: "7.2", uncertain: true }), fact(t, "had chicken rice", { kind: "MEAL_OR_FOOD_NOTE" })], [fact(t, "my knee hurts").sourceSpan]),
    ).toMatchObject({ kind: "VALID" });
  });
});

describe("Packet 13 extraction validator: every r-rule rejects", () => {
  const t = "Sugar 6.5 this morning";
  const ok = () => fact(t, "Sugar 6.5 this morning", { value: "6.5" });
  const cases: [string, () => ReturnType<typeof check>, ExtractionRejectionReason][] = [
    ["schema", () => validateExtraction(request(t), { facts: [{ ...ok(), advice: "eat less" }], unsupportedSpans: [] }, { isRedirect: noRedirect }), "SCHEMA_INVALID"],
    ["span offsets", () => check(t, [{ ...ok(), sourceSpan: { start: 1, end: 22, text: "Sugar 6.5 this morning" } }]), "SPAN_NOT_VERBATIM"],
    ["span out of range", () => check(t, [{ ...ok(), sourceSpan: { start: 0, end: 40, text: "Sugar 6.5 this morning" } }]), "SPAN_OUT_OF_RANGE"],
    ["value not spoken", () => check(t, [{ ...ok(), value: "7.5" }]), "VALUE_NOT_IN_SPAN"],
    ["unit not spoken", () => check(t, [{ ...ok(), unit: "MMOL_PER_L" }]), "UNIT_NOT_IN_SPAN"],
    ["glucose without value", () => check(t, [{ ...ok(), value: null }]), "GLUCOSE_VALUE_REQUIRED"],
    ["unit of another kind", () => check("Sugar 6.5 units", [fact("Sugar 6.5 units", "Sugar 6.5 units", { value: "6.5", unit: "UNITS" })]), "UNIT_NOT_ALLOWED_FOR_KIND"],
    ["status on glucose", () => check(t, [{ ...ok(), status: "TAKEN" }]), "STATUS_NOT_ALLOWED_FOR_KIND"],
    ["kind not allowed", () => validateExtraction(request(t, "en-SG", ["MEAL_OR_FOOD_NOTE"]), { facts: [ok()], unsupportedSpans: [] }, { isRedirect: noRedirect }), "KIND_NOT_ALLOWED"],
    ["unresolved not in span", () => check(t, [{ ...ok(), unresolvedPhrase: "insulin glargine" }]), "UNRESOLVED_NOT_IN_SPAN"],
    ["redirect covered", () => check(t, [ok()], [], "en-SG", () => true), "FACT_COVERS_REDIRECT"],
    ["duplicate", () => check(t, [ok(), ok()]), "DUPLICATE_FACT"],
    ["too many", () => validateExtraction(request(t), { facts: Array(9).fill(ok()), unsupportedSpans: [] }, { isRedirect: noRedirect }), "SCHEMA_INVALID"],
  ];
  for (const [name, run, expected] of cases) it(`${name} → ${expected}`, () => expect(reason(run())).toBe(expected));

  it("TAKEN only with an explicit taken cue, never with a negation", () => {
    // 13.2 (review IMPORTANT 1): a span with a PLANNED cue is never TAKEN.
    const planned = "I will take my insulin later";
    expect(reason(check(planned, [fact(planned, planned, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN" })]))).toBe("TAKEN_WITH_PLANNED");
    const hadTo = "I had to take my insulin later";
    expect(reason(check(hadTo, [fact(hadTo, hadTo, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN" })]))).toBe("TAKEN_WITH_PLANNED");
    const negated = "I haven't taken my insulin";
    expect(reason(check(negated, [fact(negated, negated, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", negated: true })]))).toBe("TAKEN_WITH_NEGATION");
    const z = "我还没有打胰岛素";
    expect(reason(check(z, [fact(z, z, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", negated: true })], [], "zh-SG"))).toBe("TAKEN_WITH_NEGATION");
  });

  it("review CRITICAL 1: every contracted negation, straight or curly apostrophe, makes TAKEN impossible and must be preserved", () => {
    const en = [
      "Hadn't taken",
      "I haven’t used the grey pen",
      "I hadn't injected the grey pen",
      "I hadn’t injected the grey pen",
      "I wouldn't have taken the grey pen",
      "I shouldn't have taken the grey pen",
      "I didn’t take the grey pen, took nothing",
      "The grey pen, nope, not taken",
      "Nah, grey pen not taken",
      "I mustn't have used the grey pen",
      "I weren't using it, taken nothing",
    ];
    for (const t of en) {
      expect(reason(check(t, [fact(t, t, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", negated: false })])), t).toBe("TAKEN_WITH_NEGATION");
      // Marking it negated does not make it TAKEN either.
      expect(reason(check(t, [fact(t, t, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", negated: true })])), t).toBe("TAKEN_WITH_NEGATION");
    }
    for (const t of ["灰色的笔还没打过", "我没有用过灰色的笔", "灰色的笔不是打了", "我还未吃过药"]) {
      expect(reason(check(t, [fact(t, t, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", negated: false })], [], "zh-SG")), t).toBe("TAKEN_WITH_NEGATION");
    }
    // A negated SKIPPED fact with the curly apostrophe is accepted only when negated is preserved.
    const skipped = "I didn’t take the grey pen";
    expect(reason(check(skipped, [fact(skipped, skipped, { kind: "MEDICINE_OCCURRENCE", status: "SKIPPED", negated: false })]))).toBe("NEGATION_NOT_PRESERVED");
    expect(check(skipped, [fact(skipped, skipped, { kind: "MEDICINE_OCCURRENCE", status: "SKIPPED", negated: true })])).toMatchObject({ kind: "VALID" });
  });

  it("negation must be preserved both ways, and stated uncertainty kept", () => {
    const negated = "I did not eat breakfast";
    expect(reason(check(negated, [fact(negated, negated, { kind: "MEAL_OR_FOOD_NOTE", negated: false })]))).toBe("NEGATION_NOT_PRESERVED");
    const plain = "Ate breakfast";
    expect(reason(check(plain, [fact(plain, plain, { kind: "MEAL_OR_FOOD_NOTE", negated: true })]))).toBe("NEGATION_NOT_PRESERVED");
    const unsure = "Not sure, maybe 8.1";
    expect(reason(check(unsure, [fact(unsure, unsure, { value: "8.1", uncertain: false })]))).toBe("UNCERTAINTY_NOT_PRESERVED");
    // "not sure" is uncertainty, not negation.
    expect(check(unsure, [fact(unsure, unsure, { value: "8.1", uncertain: true })])).toMatchObject({ kind: "VALID" });
  });

  it("nothing is silently dropped: an uncovered clause or number rejects", () => {
    const mixed = "Sugar 6.5, and 10 units of insulin";
    expect(reason(check(mixed, [fact(mixed, "Sugar 6.5", { value: "6.5" })]))).toBe("CONTENT_NOT_ACCOUNTED");
    expect(check(mixed, [fact(mixed, "Sugar 6.5", { value: "6.5" })], [fact(mixed, "10 units of insulin").sourceSpan])).toMatchObject({ kind: "VALID" });
    // Filler words alone need no span.
    const filler = "Um, sugar 6.5";
    expect(check(filler, [fact(filler, "sugar 6.5", { value: "6.5" })])).toMatchObject({ kind: "VALID" });
  });

  it("an empty answer for a transcript with content is CONTENT_NOT_ACCOUNTED, never silently accepted", () => {
    expect(reason(check("Sugar 6.5", []))).toBe("CONTENT_NOT_ACCOUNTED");
  });
});
