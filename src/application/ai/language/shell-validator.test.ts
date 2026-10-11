import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKET_11_FIXTURES } from "@/ai/evaluation/packet-11-fixtures";
import { PACKET_11_HYBRID_FIXTURES as R9_HYBRID_FIXTURES } from "@/ai/evaluation/packet-11-hybrid-fixtures";
import { plannedFixture, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import type { AiTaskRequest, ShellFieldPath, SlotPlan } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "../ai-hybrid-runtime-bundles";
import { localeTextAccepted, spelledCounts } from "../ai-output-validator";
import { assembleComposition } from "./assembler";
import { defaultShells } from "./default-shells";
import { MEANING_RULES, meaningMatches } from "../ai-meaning-rules";
import { CLINICAL_LABEL_CATEGORIES, CLINICAL_LABEL_ENTRIES, CLINICAL_LABEL_RULES, CLINICAL_NEUTRAL_PHRASES, CLINICAL_TOKEN_SEPARATOR, foldShellScanText, joinedZhScanText, pairJoinedCandidates, provenanceSafeMatch, r12CueWordJoined, SHELL_CLAUSE_DIRECTIVE_PATTERNS, SHELL_DIRECTIVE_PATTERNS, SHELL_R12_SPLIT_CUE_WORDS, SHELL_LEXICAL_RULES, SHELL_RULES_REVISION, shellClinicalLabel, shellDirectiveViolation, shellLexicalViolations, shellRegisterViolation, shellScanCopies, standInOccurrence, standInShadow, TRADITIONAL_TO_SIMPLIFIED } from "./shell-lexicon";
import { countSentences, languagePresent, meaningfulWording, SHELL_GATE_ORDER, shellMeaningScan, stripSlotTokens, validateShellCandidate } from "./shell-validator";
import { AI_LANGUAGE_COPY } from "./ai-language-copy";
import { verifyComposition } from "./assembler";
import { composeAiResult } from "./ai-composition";
import { composeDeterministic } from "./deterministic-composition";
import { planSlots } from "./slot-planner";
import { asHybridRequest } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { PACKET_11_HYBRID_FIXTURES } from "@/ai/evaluation/packet-11-hybrid-fixtures";

const EN = plannedFixture("p11.explain-pattern.en-sg.ordinary");
const ZH = plannedFixture("p11.explain-pattern.zh-sg.ordinary");
const bundle = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
/**
 * Observation ownership (validator profile 11b.18, 2026-10-07): the model writes only the EXPLAIN headline and evidence and the gates
 * read the remote fields only; every rule applies to each remote field identically. The rule cases in this file were written against
 * the former model-written observation (token {{S2}}). `asModelFields` replays such a case as model-written EVIDENCE wording — the
 * remote field the same text now reaches — with the observation token {{S2}} renamed to the evidence count token {{S3}} (an observation
 * text always replaces the evidence text); a case that depends on the observation's own budget, sentence count or two tokens is
 * written against the evidence or a care bullet explicitly below.
 */
const asModelFields = (texts: Record<string, string>): Record<string, string> => {
  if (!("observation" in texts)) return texts;
  const { observation, ...rest } = texts;
  return { ...rest, evidence: observation!.replaceAll("{{S2}}", "{{S3}}") };
};
const shells = (plan: SlotPlan, texts: Record<string, string>) => shellCandidate(plan, new Map(Object.entries(asModelFields(texts))) as Map<ShellFieldPath, string>);
const VALID_EN: Record<string, string> = { headline: "A look at {{S1}}.", evidence: "This is based on {{S3}}." };
// Rules r4: the plan-era control headline "看看{{S1}}。" is filler only (S7b); the valid zh control uses the approved default headline.
const VALID_ZH: Record<string, string> = { headline: "这里看的是{{S1}}。", evidence: "以上内容基于{{S3}}。" };
const check = (plan: SlotPlan, texts: Record<string, string>) => validateShellCandidate(plan, bundle, shells(plan, texts));
/**
 * Observation ownership: no model-written field holds two sentences any more (the former observation allowed two). A rule case written
 * as two sentences is rejected first by the S4 sentence budget; its rule is still asserted on the text itself by the unit matcher.
 */
const SENTENCE_BUDGET = { kind: "REJECTED", gate: "S4", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false } as const;
const twoSentences = (text: string) => countSentences(stripSlotTokens(text, "").trim()) > 1;
/**
 * Observation ownership: the AI-path assembly of validated model shells (the application's observation merged in, S9) through the
 * shared composeAiResult, in the old AssemblyResult shape; S10 is asserted by each test itself (verify is the identity here).
 */
type AssembleAiArgs = Parameters<typeof composeAiResult>;
const assembleAi = (request: AssembleAiArgs[0], plan: AssembleAiArgs[1], atoms: AssembleAiArgs[2], remote: AssembleAiArgs[3], bundleOf: AssembleAiArgs[4]) => {
  const result = composeAiResult(request, plan, atoms, remote, bundleOf, { verify: (_request, _bundle, composition) => ({ kind: "ACCEPTED", output: composition.output }) });
  return result.kind === "ACCEPTED" ? ({ kind: "ASSEMBLED", composition: result.composition } as const) : result;
};
const CARE_BUNDLE = AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY;
/** The care plan's default shells with `edit` applied to a mutable copy, validated under the care bundle. */
const careCheck = (fixtureId: string, edit: (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => void) => {
  const { plan } = plannedFixture(fixtureId);
  const texts = new Map(defaultShells(plan));
  edit(plan, texts);
  return validateShellCandidate(plan, CARE_BUNDLE, shellCandidate(plan, texts));
};
const CARE_EN = "p11.draft-care-preparation-summary.en-sg.ordinary";
const CARE_ZH = "p11.draft-care-preparation-summary.zh-sg.ordinary";

describe("shell lexicon ai-shell-rules.11b.15-r8", () => {
  // Rules r3 (owner list revision) supersedes r2 additively, r4 (wording quality) adds the S7 register and S7b wording rules, and
  // r5 (clinical labels) adds gate S6b and r6 makes its matching precise; the r2 behaviour pinned in this block is unchanged.
  it("pins the rules revision (r12 since 11b.18; r11 since 11b.17; r10 since 11b.16, with the r9 refinement; r8 since 11b.15)", () => expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12"));
  it("folds a scan copy: NFKC, apostrophes, double quotes, dashes, spaces and format characters", () => {
    expect(foldShellScanText("Don’t ‘x’ ‛y ʼ ʹ ′ ＇ ` ´")).toBe("Don't 'x' 'y ' ' ' ' ' '");
    expect(foldShellScanText("“a” „b‟ ″c″ ＂d＂ «e»")).toBe('"a" "b" "c" "d" "e"');
    expect(foldShellScanText("a‐b‑c‒d–e—f―g−h")).toBe("a-b-c-d-e-f-g-h");
    expect(foldShellScanText("a\u00A0b\u202Fc\u2007d\u3000e")).toBe("a b c d e");
    expect(foldShellScanText("ｐｌｅａｓｅ ① ｛｛Ｓ２｝｝")).toBe("please 1 {{S2}}");
    expect(foldShellScanText("rec\u200Bor\u00ADds\u202E")).toBe("records");
    expect(foldShellScanText("plain text")).toBe("plain text");
  });
  it("fix round 1: folds the further apostrophe-like and double-quote-like characters", () => {
    for (const char of ["\u02BB", "\u02BD", "\u02C8", "\uA78C", "\u055A", "\u05F3", "\u2035", "\u1FBF", "\u1FBD"]) expect(foldShellScanText(`Don${char}t`), char.codePointAt(0)!.toString(16)).toBe("Don't");
    for (const char of ["\u275D", "\u275E", "\u2039", "\u203A", "\u301D", "\u301E", "\u301F", "\u02EE"]) expect(foldShellScanText(`a${char}b`), char.codePointAt(0)!.toString(16)).toBe('a"b');
  });
  it("applies the unchanged word lists to typographic variants", () => {
    expect(shellDirectiveViolation("Don’t forget the item.")).toBe(true);
    expect(shellDirectiveViolation("ｐｌｅａｓｅ note the item.")).toBe(true);
    expect(shellLexicalViolations("Your “records” show it.", "en-SG")).toContain("QUOTATION");
    expect(shellLexicalViolations("Over ｔｗｏ periods.", "en-SG")).toContain("NUMBER_WORD");
  });
  it("fix round 2: the zh CJK-punctuation allowlist is exactly U+3000–U+3003, U+3008–U+3011 and U+3014–U+301C", () => {
    const allowed = (code: number) => (code >= 0x3000 && code <= 0x3003) || (code >= 0x3008 && code <= 0x3011) || (code >= 0x3014 && code <= 0x301c);
    for (let code = 0x3000; code <= 0x303f; code += 1) {
      const violations = shellLexicalViolations(`您的记录${String.fromCodePoint(code)}显示`, "zh-SG");
      // U+301D–U+301F fold to ASCII " (QUOTATION), never to an allowlisted block character.
      if (allowed(code) || (code >= 0x301d && code <= 0x301f)) expect(violations, code.toString(16)).not.toContain("DISALLOWED_CHARACTER");
      else expect(violations, code.toString(16)).toContain("DISALLOWED_CHARACTER");
    }
  });
  it("fix round 2: any combining mark left in the folded copy is DISALLOWED_CHARACTER in both locales", () => {
    for (const mark of ["\u0301", "\u0331", "\u302A", "\u302F", "\u20DD", "\u0488"]) {
      expect(shellLexicalViolations(`Your rec${mark}ords`, "en-SG"), mark.codePointAt(0)!.toString(16)).toContain("DISALLOWED_CHARACTER");
      expect(shellLexicalViolations(`您的记${mark}录`, "zh-SG"), mark.codePointAt(0)!.toString(16)).toContain("DISALLOWED_CHARACTER");
    }
  });
  it("fix round 2: the zh scan copy removes whitespace between two CJK ideographs; en and the displayed text are untouched", () => {
    expect(foldShellScanText("建 议\u3000您看 a b 。 x", "zh-SG")).toBe("建议您看 a b 。 x");
    expect(foldShellScanText("建\u00A0\u3000 议", "zh-SG")).toBe("建议");
    expect(foldShellScanText("建 议", "en-SG")).toBe("建 议");
    expect(foldShellScanText("建 议")).toBe("建 议");
    expect(shellDirectiveViolation("建\u3000议您看该项。", "zh-SG")).toBe(true);
    expect(shellLexicalViolations("血 糖记录", "zh-SG")).toContain("MEASURE_NAME");
  });
  it("fix round 1: DISALLOWED_CHARACTER outside the locale allowlist of the folded copy", () => {
    expect(shellLexicalViolations("Your records show it.", "en-SG")).toEqual([]);
    // Fix round 3: fullwidth punctuation is outside the en allowlist and is not a fold source, so the original text fails.
    expect(shellLexicalViolations("Your records：show it（here）.", "en-SG")).toEqual(["DISALLOWED_CHARACTER"]);
    expect(shellLexicalViolations("Your “records” — it’s here.", "en-SG")).toEqual(["QUOTATION"]);
    expect(shellLexicalViolations("Your records show it。", "en-SG")).toContain("DISALLOWED_CHARACTER");
    expect(shellLexicalViolations("Your 记录 show it.", "en-SG")).toContain("DISALLOWED_CHARACTER");
    expect(shellLexicalViolations("Your records\u0009show it.", "en-SG")).toContain("DISALLOWED_CHARACTER");
    expect(shellLexicalViolations("您的记录，显示为、「这里」。", "zh-SG")).toEqual(["QUOTATION"]);
    // Fix round 3: … (U+2026) is neither allowlisted nor a fold source.
    expect(shellLexicalViolations("您的记录…", "zh-SG")).toEqual(["DISALLOWED_CHARACTER"]);
    expect(shellLexicalViolations("您的记录\u3000显示为 mmol 看", "zh-SG")).not.toContain("DISALLOWED_CHARACTER");
    // The allowlist applies to the folded copy: NFKC maps the fullwidth sign ￥ (U+FFE5) to ¥ (U+00A5), which is outside it.
    expect(shellLexicalViolations("您的记录￥", "zh-SG")).toContain("DISALLOWED_CHARACTER");
    for (const char of ["\u3164", "\u115F", "\uFFA0", "\u034F", "\uFE0F", "\u{E0100}", "\u2800", "\uFFFC", "\u0435", "\u0131", "\u1D18", "\u00E9", "\u0301", "\u2F8F", "\u00A9"]) {
      const code = char.codePointAt(0)!.toString(16);
      expect(shellLexicalViolations(`Your rec${char}ords`, "en-SG"), `en ${code}`).toContain("DISALLOWED_CHARACTER");
      if (char !== "\u2F8F") expect(shellLexicalViolations(`您的记录${char}显示`, "zh-SG"), `zh ${code}`).toContain("DISALLOWED_CHARACTER");
    }
  });
  it("reports FORMAT_CHARACTER for Cf and Cc characters except tab, line feed and carriage return", () => {
    for (const char of ["\u200B", "\u200C", "\u200D", "\u200E", "\u200F", "\u202A", "\u202E", "\u2060", "\u2064", "\uFEFF", "\u00AD", "\u0000", "\u0007", "\u007F", "\u0085"]) expect(shellLexicalViolations(`Your rec${char}ords`, "en-SG"), char.codePointAt(0)!.toString(16)).toContain("FORMAT_CHARACTER");
    for (const char of ["\t", "\n", "\r", " ", "\u00A0", "\u3000"]) expect(shellLexicalViolations(`Your records${char}here`, "en-SG"), char.codePointAt(0)!.toString(16)).not.toContain("FORMAT_CHARACTER");
  });
});

describe("shell validator ai-shell-rules.11b.15-r8", () => {
  it.each([
    [{ headline: "Here is a comparison of {{S1}}.", observation: "Side by side, the values are {{S2}}.", evidence: "Drawn from {{S3}} in your journal." }],
    [VALID_EN],
  ])("accepts natural English variants %#", (texts) => expect(check(EN.plan, texts).kind).toBe("VALID"));
  it.each([[VALID_ZH], [{ headline: "这里比较的是{{S1}}。", observation: "对照来看，数值是{{S2}}。", evidence: "以上内容基于{{S3}}。" }]])("accepts natural Chinese variants %#", (texts) => expect(check(ZH.plan, texts).kind).toBe("VALID"));

  it("S1: an object followed by an extra } is SCHEMA_INVALID and repairable under the bundle", () => {
    const raw = `${JSON.stringify(shells(EN.plan, VALID_EN))}}`;
    expect(validateShellCandidate(EN.plan, bundle, raw)).toMatchObject({ kind: "REJECTED", gate: "S1", reason: "SCHEMA_INVALID", repairable: true });
  });
  it("S2: extra key, wrong version and locale mismatch", () => {
    expect(validateShellCandidate(EN.plan, bundle, { ...shells(EN.plan, VALID_EN), extra: 1 })).toMatchObject({ gate: "S2", reason: "SCHEMA_INVALID" });
    expect(validateShellCandidate(EN.plan, bundle, { ...shells(EN.plan, VALID_EN), schemaVersion: "ai-shell.explain-pattern@11b.5" })).toMatchObject({ gate: "S2", reason: "SCHEMA_INVALID" });
    expect(validateShellCandidate(EN.plan, bundle, { ...shells(EN.plan, VALID_EN), locale: "zh-SG" })).toMatchObject({ gate: "S2", reason: "LOCALE_INVALID", repairable: false });
  });
  it("S2: a care output whose sections or bullets do not match the plan", () => {
    const care = plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary");
    const candidate = shellCandidate(care.plan, new Map(care.plan.fields.map((field) => [field.path, field.requiredSlots.map((slot) => `{{${slot}}}`).join(", ") || "Things you chose:"])) as never) as any;
    candidate.shells.sections[0].bullets.push("{{S9}}");
    expect(validateShellCandidate(care.plan, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, candidate)).toMatchObject({ gate: "S2", reason: "SCHEMA_INVALID" });
  });
  it("S2a: an ABSTAIN outcome is MODEL_ABSTAINED", () => {
    const candidate = { ...shells(EN.plan, VALID_EN), outcome: "ABSTAIN", abstentionReason: "AMBIGUOUS_INPUT", shells: null };
    expect(validateShellCandidate(EN.plan, bundle, candidate)).toMatchObject({ gate: "S2a", reason: "MODEL_ABSTAINED", repairable: false });
  });
  it.each([
    ["spaced token", { observation: "Your records show {{ S2 }}." }, "TOKEN_MALFORMED"],
    ["lower-case token", { observation: "Your records show {{s2}}." }, "TOKEN_MALFORMED"],
    ["single braces", { observation: "Your records show {S2}." }, "TOKEN_MALFORMED"],
    ["leading zero", { observation: "Your records show {{S02}}." }, "TOKEN_MALFORMED"],
    ["extra brace", { observation: "Your records show {{S2}}}." }, "TOKEN_MALFORMED"],
    ["bare identifier", { observation: "Your records show S2 {{S2}}." }, "TOKEN_MALFORMED"],
    ["full-width look-alike token", { observation: "Your records show ｛｛Ｓ２｝｝." }, "TOKEN_MALFORMED"],
    ["bracket look-alike token", { observation: "Your records show ⟦S2⟧ {{S2}}." }, "TOKEN_MALFORMED"],
    ["out-of-range token", { observation: "Your records show {{S2}} {{S33}}." }, "TOKEN_MALFORMED"],
    ["token in another field", { headline: "A look at {{S1}} and {{S3}}.", evidence: "This is based on your records." }, "TOKEN_STRAY"],
    ["application-owned observation token in a model field", { evidence: "This is based on {{S3}} and {{S2}}." }, "TOKEN_STRAY"],
    ["unknown token", { observation: "Your records show {{S2}} and {{S4}}." }, "TOKEN_STRAY"],
    ["duplicate token", { observation: "Your records show {{S2}} and {{S2}}." }, "TOKEN_DUPLICATE"],
    ["missing token", { evidence: "This is based on your records." }, "TOKEN_MISSING"],
  ])("S3 Review Focus: rejects %s as REFERENCE_MISMATCH with integrity %s", (_label, override, integrity) => {
    expect(check(EN.plan, { ...VALID_EN, ...override })).toEqual({ kind: "REJECTED", gate: "S3", reason: "REFERENCE_MISMATCH", repairable: false, integrity });
  });
  it("S3 order group (two dates), 11b.18: the model never writes the observation, so it cannot reorder its dates (a model observation is S2); the composed observation keeps the planned order", () => {
    const fixture = PACKET_11_FIXTURES.find((entry) => entry.locale === "en-SG" && entry.taskType === "EXPLAIN_PATTERN" && (entry.request.facts as any[]).filter((fact) => fact.value.kind === "DATE").length === 2)!;
    const { request, plan, atoms } = plannedFixture(fixture.id);
    const [first, second] = plan.slots.filter((slot) => slot.orderGroup === "dates").map((slot) => slot.slotId);
    const base = shellCandidate(plan, defaultShells(plan)) as { shells: Record<string, string> };
    expect(validateShellCandidate(plan, bundle, { ...base, shells: { ...base.shells, observation: `Dates: {{${second}}} and {{${first}}}.` } })).toMatchObject({ gate: "S2", reason: "SCHEMA_INVALID" });
    const remote = (validateShellCandidate(plan, bundle, base) as Extract<ReturnType<typeof validateShellCandidate>, { kind: "VALID" }>).shells;
    for (const variant of [1, 2]) {
      const composed = composeAiResult(request, plan, atoms, remote, bundle, { variant });
      expect(composed.kind === "ACCEPTED" && composed.composition.fields.get("observation")!.spans.map((span) => span.slotId)).toEqual([first, second]);
    }
  });
  it("S3 TOKEN_REORDERED: any order other than requiredSlots is rejected, also outside order groups (care bullet)", () => {
    const fixture = PACKET_11_FIXTURES.filter((entry) => entry.taskType === "DRAFT_CARE_PREPARATION_SUMMARY").map((entry) => { try { return plannedFixture(entry.id); } catch { return null; } }).find((entry) => entry !== null && entry.plan.fields.some((field) => field.path.includes("bullets") && field.requiredSlots.length >= 2))!;
    expect(fixture).toBeDefined();
    const field = fixture.plan.fields.find((entry) => entry.path.includes("bullets") && entry.requiredSlots.length >= 2)!;
    const texts = new Map(defaultShells(fixture.plan));
    texts.set(field.path, [...field.requiredSlots].reverse().map((slot) => `{{${slot}}}`).join(", "));
    expect(validateShellCandidate(fixture.plan, CARE_BUNDLE, shellCandidate(fixture.plan, texts))).toEqual({ kind: "REJECTED", gate: "S3", reason: "REFERENCE_MISMATCH", repairable: false, integrity: "TOKEN_REORDERED" });
  });
  it("S3 INVENTORY_MISMATCH: the echoed token inventory must equal the plan's exactly, checked before the fields", () => {
    const base = shells(EN.plan, VALID_EN);
    for (const tokenInventory of [["S1", "S3", "S2"], ["S1", "S2"], ["S1", "S2", "S3", "S3"], ["S1", "S2", "S3", "S4"], ["S2", "S1", "S3"]]) {
      expect(validateShellCandidate(EN.plan, bundle, { ...base, tokenInventory }), tokenInventory.join()).toEqual({ kind: "REJECTED", gate: "S3", reason: "REFERENCE_MISMATCH", repairable: false, integrity: "INVENTORY_MISMATCH" });
    }
    const broken = shells(EN.plan, { ...VALID_EN, evidence: "This is based on your records." });
    expect(validateShellCandidate(EN.plan, bundle, { ...broken, tokenInventory: ["S1", "S3", "S2"] })).toMatchObject({ gate: "S3", integrity: "INVENTORY_MISMATCH" });
    // A wrong slot plan version echo never reaches S3: the exact schema literal refuses it at S2 (structural).
    expect(validateShellCandidate(EN.plan, bundle, { ...base, slotPlanVersion: "ai-slot-plan.11b.6" })).toMatchObject({ gate: "S2", reason: "SCHEMA_INVALID" });
    const care = plannedFixture(CARE_EN).plan;
    const careBase = shellCandidate(care, defaultShells(care));
    expect(validateShellCandidate(care, CARE_BUNDLE, careBase).kind).toBe("VALID");
    expect(validateShellCandidate(care, CARE_BUNDLE, { ...careBase, tokenInventory: [...(careBase.tokenInventory as string[])].reverse() })).toMatchObject({ gate: "S3", integrity: "INVENTORY_MISMATCH" });
  });
  it("S3: a VALID result carries no integrity sub-code, and only S3 rejections carry one", () => {
    expect(check(EN.plan, VALID_EN)).not.toHaveProperty("integrity");
    expect(check(EN.plan, { ...VALID_EN, observation: "Your records show {{S2}} mmol/L." })).not.toHaveProperty("integrity");
  });
  it("S4: field budget, sentence limit and empty framed field", () => {
    expect(check(EN.plan, { ...VALID_EN, headline: `${"Very ".repeat(30)}{{S1}}.` })).toMatchObject({ gate: "S4", reason: "OUTPUT_BUDGET_EXCEEDED" });
    expect(check(EN.plan, { ...VALID_EN, headline: "Look. Here. {{S1}}." })).toMatchObject({ gate: "S4" });
    expect(check(EN.plan, { ...VALID_EN, headline: "{{S1}}" })).toMatchObject({ gate: "S4" });
    expect(countSentences("Recorded values: x. Recorded items: y.")).toBe(2);
    expect(countSentences("记录的数值：x。记录的项目：y。")).toBe(2);
  });
  it.each([
    ["en headline", { headline: "★ {{S1}}" }],
    ["en observation", { observation: "→ {{S2}}." }],
  ])("S4b: a token-only %s (symbols, no letter) is OUTPUT_BUDGET_EXCEEDED, not repairable", (_label, override) => {
    expect(check(EN.plan, { ...VALID_EN, ...override })).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
  });
  it.each([
    ["zh headline", { headline: "Look at {{S1}}。" }],
    ["zh observation", { observation: "→ {{S2}}。" }],
  ])("S4b: a %s without a CJK ideograph is OUTPUT_BUDGET_EXCEEDED", (_label, override) => {
    expect(check(ZH.plan, { ...VALID_ZH, ...override })).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
  });
  it("S7b (rules r4): the evidence needs meaningful wording; 11b.18: the evidence is a presence group (S4b) as a model field; an empty framed evidence stays S4", () => {
    expect(check(EN.plan, { ...VALID_EN, evidence: "So {{S3}}." })).toEqual({ kind: "REJECTED", gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false, quality: { code: "NOT_MEANINGFUL", fieldKind: "evidence" } });
    expect(check(EN.plan, { ...VALID_EN, evidence: "+ {{S3}}." })).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
    expect(check(EN.plan, { ...VALID_EN, evidence: "{{S3}}." })).toMatchObject({ gate: "S4" });
  });
  it("S4b (reachable through the plan): a care section whose intro and bullets hold no letter or ideograph", () => {
    expect(careCheck(CARE_EN, (plan, texts) => texts.set(plan.sections[0]!.introPath, "★ →"))).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
    expect(careCheck(CARE_ZH, (plan, texts) => texts.set(plan.sections[0]!.introPath, "Notes:"))).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
    // Rules r4: words in a bullet no longer rescue an intro that holds only symbols; the section intro itself must carry
    // wording. The presence stage (S4b) passes on the bullet's words; the r4 wording gate S7b rejects the intro.
    expect(careCheck(CARE_EN, (plan, texts) => {
      const section = plan.sections[0]!;
      texts.set(section.introPath, "+");
      texts.set(section.bulletPaths[0]!, `Chosen: ${texts.get(section.bulletPaths[0]!)}`);
    })).toEqual({ kind: "REJECTED", gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false, quality: { code: "NOT_MEANINGFUL", fieldKind: "intro" } });
    // The stricter intro rule still fires first (S4) for an intro of punctuation only.
    expect(careCheck(CARE_EN, (plan, texts) => texts.set(plan.sections[0]!.introPath, "…:"))).toMatchObject({ gate: "S4", reason: "OUTPUT_BUDGET_EXCEEDED" });
  });
  it.each([
    ["en headline", { headline: "\u3164{{S1}}" }],
    ["en observation", { observation: "\u3164{{S2}}" }],
    ["en headline (U+115F)", { headline: "\u115F{{S1}}" }],
    ["en observation (U+FFA0)", { observation: "\uFFA0{{S2}}" }],
    ["en headline (Cyrillic only)", { headline: "\u0435\u0441\u0442{{S1}}" }],
  ])("S4b fix round 1: a filler or non-allowlisted letter is no language (%s)", (_label, override) => {
    expect(check(EN.plan, { ...VALID_EN, ...override })).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
  });
  it("S4b fix round 1: zh fillers and Hangul are no language", () => {
    expect(check(ZH.plan, { ...VALID_ZH, headline: "\u3164{{S1}}" })).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
  });
  it("S4b helper: en needs an ASCII letter, zh a CJK ideograph (U+3400–U+9FFF, U+F900–U+FAFF), on the folded copy", () => {
    expect(languagePresent("{{S1}} ★ → …", "en-SG")).toBe(false);
    expect(languagePresent("{{S1}}", "en-SG")).toBe(false);
    expect(languagePresent("A {{S1}}", "en-SG")).toBe(true);
    expect(languagePresent("ａ {{S1}}", "en-SG")).toBe(true);
    expect(languagePresent("가 {{S1}}", "en-SG")).toBe(false);
    expect(languagePresent("\u3164{{S1}}", "en-SG")).toBe(false);
    expect(languagePresent("\u00E9{{S1}}", "en-SG")).toBe(false);
    expect(languagePresent("\u3164{{S1}}", "zh-SG")).toBe(false);
    expect(languagePresent("Look {{S1}}", "zh-SG")).toBe(false);
    expect(languagePresent("가 {{S1}}", "zh-SG")).toBe(false);
    expect(languagePresent("{{S1}}，。", "zh-SG")).toBe(false);
    expect(languagePresent("看{{S1}}", "zh-SG")).toBe(true);
    expect(languagePresent("\u3400{{S1}}", "zh-SG")).toBe(true);
    expect(languagePresent("\uF900{{S1}}", "zh-SG")).toBe(true);
  });
  it.each([
    ["en", { observation: "Your readings rose to {{S2}}." }, "COMPARATIVE_DIRECTION"],
    ["en", { observation: "Over two periods, {{S2}}." }, "NUMBER_WORD"],
    ["en", { observation: "Your records show {{S2}} mmol/L." }, "UNIT"],
    ["en", { observation: "Last week your records show {{S2}}." }, "DATE_OR_TIME"],
    ["en", { observation: "Your glucose records show {{S2}}." }, "MEASURE_NAME"],
    ["en", { observation: "Your records show {{S2}} (about 10%)." }, "DIGIT"],
    ["en", { observation: 'Your records "show" {{S2}}.' }, "QUOTATION"],
    ["zh", { observation: "记录显示{{S2}}，两次都一样。" }, "NUMBER_WORD"],
    ["zh", { observation: "上周的数值是{{S2}}。" }, "DATE_OR_TIME"],
    ["zh", { observation: "数值上升到{{S2}}。" }, "COMPARATIVE_DIRECTION"],
    ["zh", { observation: "您的血糖是{{S2}}。" }, "MEASURE_NAME"],
    ["en", { observation: "Your “records” show {{S2}}." }, "QUOTATION"],
    ["en", { observation: "Your ″records″ show {{S2}}." }, "QUOTATION"],
    ["en", { observation: "Your ＂records＂ show {{S2}}." }, "QUOTATION"],
    ["en", { observation: "Your rec\u200Bords show {{S2}}." }, "FORMAT_CHARACTER"],
    ["en", { observation: "Your records show {{S2}}\u202E." }, "FORMAT_CHARACTER"],
    ["en", { observation: "Your re\u00ADcords show {{S2}}." }, "FORMAT_CHARACTER"],
    ["en", { observation: "\uFEFFYour records show {{S2}}." }, "FORMAT_CHARACTER"],
    ["en", { observation: "Your records show {{S2}}\u0007." }, "FORMAT_CHARACTER"],
    ["en", { observation: "Over ｔｗｏ periods, {{S2}}." }, "NUMBER_WORD"],
    ["en", { observation: "Your ｇｌｕｃｏｓｅ records show {{S2}}." }, "MEASURE_NAME"],
    ["en", { observation: "Your records show {{S2}} ①." }, "DIGIT"],
    ["en", { observation: "Your records show {{S2}} (see fact–1)." }, "REFERENCE"],
    ["zh", { observation: "记录显示{{S2}}\u200B。" }, "FORMAT_CHARACTER"],
  ])("S5 (%s): rejects %j as FACT_FIDELITY_FAILED with %s", (locale, override, violation) => {
    const result = check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), ...override });
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect((result as unknown as { lexical: string[] }).lexical).toContain(violation);
  });
  it.each([
    ["en", { observation: "Earlier and recent values in your records: {{S2}}." }],
    ["en", { observation: "Side by side, your journal shows {{S2}}." }],
    ["zh", { observation: "对照来看，同一时段一直记录的数值是{{S2}}。" }],
    ["zh", { observation: "一些记录显示{{S2}}。" }],
    ["en", { headline: "You’re looking at {{S1}}.", observation: "Here’s what your journal shows: {{S2}}." }],
    ["en", { observation: "Your records — side by side — show {{S2}}." }],
    ["en", { observation: "Your\u00A0records show {{S2}}." }],
    ["en", { evidence: "This is based on {{S3}} you’ve kept in your journal." }],
    ["en", { observation: "Your records show {{S2}}." }],
    ["en", { observation: "You’re seeing {{S2}}." }],
    ["zh", { observation: "您的记录显示为{{S2}}。" }],
    ["zh", { observation: "对照来看，数值是{{S2}}。" }],
    ["zh", { observation: "您的记录、《饮食日志》显示为{{S2}}。" }],
    ["zh", { headline: "看看{{S1}}、以及《记录》中的内容。" }],
    ["zh", { observation: "对照来看：您的记录（同一时段）显示为{{S2}}。" }],
    ["zh", { observation: "您的记录\u3000显示为{{S2}}。" }],
    ["zh", { headline: "看看{{S1}}，以及相关内容。" }],
  ])("S5 false-positive control (%s) %j is accepted", (locale, override) => {
    expect(check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), ...override }).kind).toBe("VALID");
  });
  it.each([
    ["en", { observation: "{{S2}} is a bit high." }, "CLINICAL_MEANING_VIOLATION"],
    ["en", { observation: "Please check {{S2}} with your doctor." }, "CLINICAL_MEANING_VIOLATION"],
    ["en", { observation: "I have updated your records with {{S2}}." }, "AUTHORITY_BOUNDARY_VIOLATION"],
    ["zh", { observation: "{{S2}}偏高。" }, "CLINICAL_MEANING_VIOLATION"],
    ["zh", { observation: "建议您记录{{S2}}。" }, "CLINICAL_MEANING_VIOLATION"],
    ["en", { observation: "Don’t forget {{S2}}." }, "CLINICAL_MEANING_VIOLATION"],
    ["en", { observation: "Donʼt forget {{S2}}." }, "CLINICAL_MEANING_VIOLATION"],

    ["en", { observation: "You’re all fine with {{S2}}." }, "CLINICAL_MEANING_VIOLATION"],
  ])("S6 (%s): rejects %j", (locale, override, reason) => {
    expect(check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), ...override })).toMatchObject({ gate: "S6", reason });
  });
  it("S7: wrong-language zh shells are LOCALE_INVALID; wrong-language en text stops earlier (S4b or S5 allowlist)", () => {
    expect(check(ZH.plan, { ...VALID_ZH, observation: "您的 records show {{S2}} here." })).toMatchObject({ gate: "S7", reason: "LOCALE_INVALID" });
    expect(check(EN.plan, { ...VALID_EN, observation: "记录显示 {{S2}}." })).toMatchObject({ gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED" });
    const mixed = check(EN.plan, { ...VALID_EN, observation: "Your records 记录 show {{S2}}." });
    expect(mixed).toMatchObject({ gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect((mixed as unknown as { lexical: string[] }).lexical).toContain("DISALLOWED_CHARACTER");
  });
  it.each([
    ...["\u302A", "\u302B", "\u302C", "\u302D", "\u302E", "\u302F", "\u303E", "\u303F"].map((char) => ({ observation: `建${char}议您看{{S2}}。` })),
    { observation: "血\u302A糖记录为{{S2}}。" },
    { observation: "数值上\u302A升：{{S2}}。" },
    { observation: "{{S2}}偏\u302A高。" },
    { observation: "两\u302A次记录：{{S2}}。" },
    { observation: "上\u302A周的数值：{{S2}}。" },
    { observation: "\u3022次记录显示{{S2}}。" },
    { observation: "\u3007次记录显示{{S2}}。" },
    { observation: "\u3038次记录显示{{S2}}。" },
  ])("S5 fix round 2 (zh): rejects %j as DISALLOWED_CHARACTER", (override) => {
    const result = check(ZH.plan, { ...VALID_ZH, ...override });
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false });
    expect((result as unknown as { lexical: string[] }).lexical).toContain("DISALLOWED_CHARACTER");
  });
  it.each([["建\u3000议您看{{S2}}。"], ["建 议您看{{S2}}。"], ["建\u00A0议您看{{S2}}。"]])("S6 fix round 2 (zh): a gap inside 建议 (%j) is still a directive", (observation) => {
    expect(check(ZH.plan, { ...VALID_ZH, observation })).toMatchObject({ kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" });
  });
  it("S5 fix round 2 (zh): a gap inside a listed word is still matched", () => {
    const result = check(ZH.plan, { ...VALID_ZH, observation: "血 糖记录为{{S2}}。" });
    expect(result).toMatchObject({ gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect((result as unknown as { lexical: string[] }).lexical).toContain("MEASURE_NAME");
    expect(check(ZH.plan, { ...VALID_ZH, observation: "上\u3000周的数值：{{S2}}。" })).toMatchObject({ gate: "S5", reason: "FACT_FIDELITY_FAILED" });
  });
  it("fix round 3: the Kangxi radical (accepted by S7 on the folded copy in round 1) is now refused at S5 on the original text", () => {
    const result = check(ZH.plan, { ...VALID_ZH, evidence: "\u2F8F Look {{S3}}。" });
    expect(result).toMatchObject({ gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect((result as unknown as { lexical: string[] }).lexical).toContain("DISALLOWED_CHARACTER");
  });
  it.each([
    ["zh", "㈡次记录显示{{S2}}。"],
    ["zh", "共㈡次，记录显示{{S2}}。"],
    ["zh", "㈠次记录显示{{S2}}。"],
    ["zh", "㈥次记录显示{{S2}}。"],
    ["zh", "㈩次记录显示{{S2}}。"],
    ["zh", "㈪的记录显示{{S2}}。"],
    ["zh", "㊊的记录显示{{S2}}。"],
    ["zh", "记录显示{{S2}}㏄。"],
    ["zh", "⺟的记录显示{{S2}}。"],
    ["zh", "⻳的记录显示{{S2}}。"],
    ["zh", "记录\uFE11显示为{{S2}}。"],
    ["zh", "记录\uFE10显示为{{S2}}。"],
    ["zh", "记录\uFE30显示为{{S2}}。"],
    ["zh", "记录\uFE4F显示为{{S2}}。"],
    ["zh", "记录\uFE51显示为{{S2}}。"],
    ["zh", "记录\uFE19显示为{{S2}}。"],
    ["zh", "\uFE3D记录\uFE3E显示为{{S2}}。"],
    ["zh", "记录\uFF64显示为{{S2}}。"],
    ["zh", "建…议您看{{S2}}。"],
    ["zh", "您的记录\u0009显示为{{S2}}。"],
    ["zh", "您的记录\u2028显示为{{S2}}。"],
    ["zh", "您的记录\u1680显示为{{S2}}。"],
    ["en", "ｐｌｅａｓｅ note {{S2}}."],
    ["en", "Ｍａｋｅ ｓｕｒｅ you see {{S2}}."],
    ["en", "\u{1D429}\u{1D425}\u{1D41E}\u{1D41A}\u{1D42C}\u{1D41E} note {{S2}}."],
    ["en", "Your records show {{S2}} ㏄."],
  ])("S5 fix round 3 (%s): the original text %j is outside the allowlist (DISALLOWED_CHARACTER)", (locale, observation) => {
    const result = check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), observation });
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false });
    expect((result as unknown as { lexical: string[] }).lexical).toContain("DISALLOWED_CHARACTER");
  });
  it.each(["、", "，", "。", ".", "-", "_", "/", "'", "~", "〜", "〃", "：", "!"].map((mark) => `建${mark}议您看{{S2}}。`).concat(["建（议）您看{{S2}}。", "建《议》您看{{S2}}。", "建【议】您看{{S2}}。", "建〈议〉您看{{S2}}。", "{{S2}}偏、高。", "应、该关注{{S2}}。", "建 、 议您看{{S2}}。"]))("S6 fix round 3 (zh): punctuation splitting a listed word (%j) is still matched", (observation) => {
    if (twoSentences(observation)) {
      // A sentence-ending mark splits the word into two sentences: the one-sentence model field rejects it at S4 first.
      expect(check(ZH.plan, { ...VALID_ZH, observation })).toEqual(SENTENCE_BUDGET);
      const scan = shellMeaningScan(observation, "zh-SG", AI_LANGUAGE_COPY.tokenStandIn["zh-SG"]);
      expect(scan.directive || scan.clinical).toBe(true);
      return;
    }
    expect(check(ZH.plan, { ...VALID_ZH, observation })).toMatchObject({ kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" });
  });
  it.each([
    ["血、糖记录为{{S2}}。", "MEASURE_NAME"],
    ["上、周的数值：{{S2}}。", "DATE_OR_TIME"],
    ["数值上-升：{{S2}}。", "COMPARATIVE_DIRECTION"],
    ["记录显示两、次{{S2}}。", "NUMBER_WORD"],
    ["记录了三（次）{{S2}}。", "NUMBER_WORD"],
  ])("S5 fix round 3 (zh): punctuation splitting a listed word (%j) is still %s", (observation, violation) => {
    const result = check(ZH.plan, { ...VALID_ZH, observation });
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect((result as unknown as { lexical: string[] }).lexical).toContain(violation);
  });
  it.each([
    ["您的记录显示为{{S2}}。"],
    ["对照来看，数值是{{S2}}。"],
    // Rules r4: padded to five ideographs (the unpadded form is rejected only by the r4 wording stage; see the r4 block).
    ["您的记录、整理：{{S2}}。"],
    ["您的记录、《饮食日志》显示为{{S2}}。"],
    ["对照来看：您的记录（同一时段）显示为{{S2}}。"],
  ])("fix round 3 (zh) control: %j is accepted", (observation) => {
    expect(check(ZH.plan, { ...VALID_ZH, observation }).kind).toBe("VALID");
  });
  it("fix round 3: the joined zh scan copy removes punctuation, symbols and whitespace between ideographs until stable", () => {
    // Fix round 4: a single ASCII letter standing alone between ideographs is removed too; two letters are kept.
    expect(joinedZhScanText("建（议）您、看 a. 好")).toBe("建议您看好");
    expect(joinedZhScanText("建（议）您、看 ab. 好")).toBe("建议您看 ab. 好");
    expect(joinedZhScanText("建...议")).toBe("建议");
    expect(joinedZhScanText("a, b")).toBe("a, b");
  });
  type Field = "headline" | "observation" | "evidence";
  const rejectedAt = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  const lexicalOf = (result: unknown) => (result as { lexical?: string[] }).lexical ?? [];
  it.each([
    // 1. zh UNIT words on the joined copy.
    ["zh", "observation", "记录显示{{S2}}公、斤。", "S5", "UNIT"],
    ["zh", "observation", "记录显示{{S2}}公（斤）。", "S5", "UNIT"],
    ["zh", "observation", "记录显示{{S2}}毫、升。", "S5", "UNIT"],
    ["zh", "evidence", "以上内容基于{{S3}}毫、升。", "S5", "UNIT"],
    ["zh", "observation", "记录显示{{S2}}毫-克。", "S5", "UNIT"],
    ["zh", "observation", "记录显示{{S2}}厘、米。", "S5", "UNIT"],
    ["zh", "observation", "记录显示{{S2}}毫，克。", "S5", "UNIT"],
    // 2. zh numeral look-alikes.
    ["zh", "observation", "－月的记录显示{{S2}}。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "—月的记录显示{{S2}}。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "―月的记录显示{{S2}}。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "‒月的记录显示{{S2}}。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "＋月的记录显示{{S2}}。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "＋＝月的记录显示{{S2}}。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "＝月的记录显示{{S2}}。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "记录显示{{S2}}在周－。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "记录显示{{S2}}在星期－。", "S5", "DATE_OR_TIME"],
    ["zh", "observation", "共＋次，记录显示{{S2}}。", "S5", "NUMBER_WORD"],
    ["zh", "observation", "共＝次，记录显示{{S2}}。", "S5", "NUMBER_WORD"],
    ["zh", "observation", "共—次，记录显示{{S2}}。", "S5", "NUMBER_WORD"],
    ["zh", "headline", "－月：{{S1}}。", "S5", "DATE_OR_TIME"],
    // 3. zh stroke ideographs are outside the allowlist.
    ["zh", "observation", "建丶议您看{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "建丨议您看{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "建丿议您看{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "建亅议您看{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "建乀议您看{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "建乁议您看{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "建乛议您看{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "应丶该关注{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "血丶糖记录为{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "上丶周的数值：{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "observation", "{{S2}}偏丶高。", "S5", "DISALLOWED_CHARACTER"],
    ["zh", "headline", "建丶议看看{{S1}}。", "S5", "DISALLOWED_CHARACTER"],
    // 4. zh single Latin-letter separators.
    ["zh", "observation", "建l议您看{{S2}}。", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "observation", "建I议您看{{S2}}。", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "observation", "建Ｉ议您看{{S2}}。", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "observation", "建 l 议您看{{S2}}。", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "observation", "血l糖记录为{{S2}}。", "S5", "MEASURE_NAME"],
    ["zh", "observation", "{{S2}}偏l高。", "S6", "CLINICAL_MEANING_VIOLATION"],
    // 5. en underscore emphasis.
    ["en", "observation", "_Please_ note {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "You _should_ check {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "It is _higher_ at {{S2}}.", "S5", "COMPARATIVE_DIRECTION"],
    ["en", "observation", "Your _glucose_ records {{S2}}.", "S5", "MEASURE_NAME"],
    ["en", "observation", "Note _two_ readings {{S2}}.", "S5", "NUMBER_WORD"],
    ["en", "observation", "Seen _yesterday_ {{S2}}.", "S5", "DATE_OR_TIME"],
    ["en", "observation", "Please_note {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "evidence", "_Please_ see {{S3}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "Your records show {{S2}} mmol_l.", "S5", "UNIT"],
    // 6. en ASCII look-alikes.
    ["en", "observation", "pIease note {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "PIease note {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "p|ease note {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "rnake sure you see {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "You shouId see {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "You rnust see {{S2}}.", "S6", "CLINICAL_MEANING_VIOLATION"],
    ["en", "observation", "It is Iower at {{S2}}.", "S5", "COMPARATIVE_DIRECTION"],
    ["en", "observation", "There is rnore at {{S2}}.", "S5", "COMPARATIVE_DIRECTION"],
    ["en", "observation", "It went dovvn at {{S2}}.", "S5", "COMPARATIVE_DIRECTION"],
    ["en", "observation", "Your gIucose records {{S2}}.", "S5", "MEASURE_NAME"],
    ["en", "observation", "Your bIood sugar records {{S2}}.", "S5", "MEASURE_NAME"],
  ] as const)("fix round 4 (%s %s): %j is rejected at %s (%s)", (locale, field, text, gate, detail) => {
    const result = rejectedAt(locale, field, text);
    if (gate === "S5") {
      expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false });
      expect(lexicalOf(result)).toContain(detail);
    } else expect(result).toMatchObject({ kind: "REJECTED", gate, reason: detail, repairable: false });
  });
  it("fix round 4: care bullets — zh UNIT and stroke separators, en underscore emphasis", () => {
    const bullet = (fixtureId: string, wrap: (text: string) => string) => careCheck(fixtureId, (plan, texts) => {
      const path = plan.sections[0]!.bulletPaths[0]!;
      texts.set(path, wrap(texts.get(path)!));
    });
    const zhUnit = bullet(CARE_ZH, (text) => `${text}公、斤`);
    expect(zhUnit).toMatchObject({ gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect(lexicalOf(zhUnit)).toContain("UNIT");
    const zhStroke = bullet(CARE_ZH, (text) => `建丶议${text}`);
    expect(zhStroke).toMatchObject({ gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect(lexicalOf(zhStroke)).toContain("DISALLOWED_CHARACTER");
    expect(bullet(CARE_EN, (text) => `_Please_ ${text}`)).toMatchObject({ gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" });
  });
  it.each([
    // r3 fix round 1: restored — the look-alike numeral map reads only a single dash, so —— stays punctuation.
    ["zh", "您的记录（同一时段）——显示为{{S2}}。"],
    ["zh", "您的记录显示为{{S2}}。"],
    ["zh", "对照来看，数值是{{S2}}。"],
    ["zh", "您的记录、整理：{{S2}}。"],
    ["en", "Your records show {{S2}}."],
    ["en", "You’re seeing {{S2}}."],
    ["en", "In your journal, the values are {{S2}}."],
    ["en", "I see {{S2}} in your records."],
    ["en", "Side by side, your journal shows {{S2}}."],
  ] as const)("fix round 4 control (%s): %j is accepted", (locale, observation) => {
    expect(rejectedAt(locale, "observation", observation).kind).toBe("VALID");
  });
  it("fix round 4: the scan copies (en: scan, underscores kept, look-alike; zh: scan, joined, look-alike joined)", () => {
    expect(shellScanCopies("_PIease_ rnake dovvn p|ease", "en-SG")).toEqual([" PIease  rnake dovvn p|ease", "_PIease_ rnake dovvn p|ease", " Please  make down please"]);
    expect(shellScanCopies("共＋次，建l议－月", "zh-SG")).toEqual(["共+次,建l议-月", "共次建议月", "共十次建议一月"]);
    expect(shellScanCopies("－月", "zh-SG")).toEqual(["-月", "-月", "一月"]);
  });
  it("S7 fix round 1: checks the original text as well as the folded copy", () => {
    expect(check(ZH.plan, { ...VALID_ZH, observation: "您的 records show {{S2}} here." })).toMatchObject({ gate: "S7", reason: "LOCALE_INVALID" });
  });
  it.each([
    ["en", { observation: "Ple\u034Fase note {{S2}}." }],
    ["en", { observation: "Ple\uFE0Fase note {{S2}}." }],
    ["en", { observation: "It is hig\u034Fher at {{S2}}." }],
    ["en", { observation: "Your gluc\u034Fose records {{S2}}." }],
    ["en", { observation: "Make\u3164sure you see {{S2}}." }],
    ["en", { observation: "Make\u115Fsure you see {{S2}}." }],
    ["en", { observation: "Make\uFFA0sure you see {{S2}}." }],
    ["zh", { observation: "建\u034F议您看{{S2}}。" }],
    ["en", { observation: "You sho\u{E0100}uld see {{S2}}." }],
    ["en", { observation: "Make\u2800sure you see {{S2}}." }],
    ["en", { observation: "Ple\uFFFCase {{S2}}." }],
    ["en", { observation: "Ple\u0331ase note {{S2}}." }],
    ["en", { observation: "You s\u0301hould see {{S2}}." }],
    ["en", { observation: "Pl\u0435ase note {{S2}}." }],
    ["en", { observation: "You sh\u043Euld see {{S2}}." }],
    ["en", { observation: "Over tw\u043E periods {{S2}}." }],
    ["en", { observation: "\u1D18\u029F\u1D07\u1D00s\u1D07 note {{S2}}." }],
    ["en", { observation: "We adv\u0131se on {{S2}}." }],
    ["en", { observation: "Your records\tshow {{S2}}." }],
    ["en", { observation: "Your records show {{S2}}。" }],
  ])("S5 fix round 1 (%s): rejects %j as DISALLOWED_CHARACTER", (locale, override) => {
    const result = check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), ...override });
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false });
    expect((result as unknown as { lexical: string[] }).lexical).toContain("DISALLOWED_CHARACTER");
  });
  it.each(["\u02BB", "\u02BD", "\u02C8", "\uA78C", "\u055A", "\u05F3", "\u2035", "\u1FBF", "\u1FBD"])("S6 fix round 1: Don%st forget is a directive", (char) => {
    expect(check(EN.plan, { ...VALID_EN, observation: `Don${char}t forget {{S2}}.` })).toMatchObject({ kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" });
  });
  it.each([["\u275D", "\u275E"], ["\u2039", "\u203A"], ["\u301D", "\u301E"], ["\u301D", "\u301F"], ["\u02EE", "\u02EE"]])("S5 fix round 1: %s…%s quotation marks are QUOTATION", (open, close) => {
    const result = check(EN.plan, { ...VALID_EN, observation: `Your ${open}records${close} show {{S2}}.` });
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect((result as unknown as { lexical: string[] }).lexical).toContain("QUOTATION");
  });
  it("S7 scans the folded copy: full-width Latin words count as Latin words in zh", () => {
    expect(check(ZH.plan, { ...VALID_ZH, observation: "记录 ｒｅｃｏｒｄｓ ｖａｌｕｅｓ ｓｈｏｗｎ {{S2}}。" })).toMatchObject({ gate: "S7", reason: "LOCALE_INVALID" });
  });
  it("folding is a scan copy only: the validated and assembled texts keep the original characters", () => {
    const texts = { ...VALID_EN, headline: "You’re looking at {{S1}}.", evidence: "Your records — side by side — show {{S3}}." };
    const result = check(EN.plan, texts);
    expect(result.kind).toBe("VALID");
    const validated = (result as Extract<typeof result, { kind: "VALID" }>).shells;
    expect(validated.get("headline")).toBe(texts.headline);
    expect(validated.get("evidence")).toBe(texts.evidence);
    const assembled = assembleAi(EN.request, EN.plan, EN.atoms, validated, bundle);
    expect(assembled.kind).toBe("ASSEMBLED");
    const payload = (assembled as any).composition.output.payload;
    expect(payload.headline.text.startsWith("You’re looking at ")).toBe(true);
    expect(payload.headline.text).not.toContain("'");
    expect(payload.evidence.text.startsWith("Your records — side by side — show ")).toBe(true);
    const zh = { ...VALID_ZH, evidence: "对照来看：您的记录（同一时段）基于{{S3}}。" };
    const zhResult = check(ZH.plan, zh);
    expect(zhResult.kind).toBe("VALID");
    const zhAssembled = assembleAi(ZH.request, ZH.plan, ZH.atoms, (zhResult as Extract<typeof zhResult, { kind: "VALID" }>).shells, bundle) as any;
    expect(zhAssembled.composition.output.payload.evidence.text.startsWith("对照来看：您的记录（同一时段）基于")).toBe(true);
  });
  it("first failure wins in gate order across fields", () => {
    expect(check(EN.plan, { ...VALID_EN, headline: "A look at {{S1}} in two ways.", evidence: "This is based on your records." })).toMatchObject({ gate: "S3" });
  });
  it("the refactored validator helpers keep their behaviour", () => {
    expect(spelledCounts("two readings and 一条")).toEqual([2, 1]);
    expect(localeTextAccepted("Your records", "en-SG")).toBe(true);
    expect(localeTextAccepted("记录", "en-SG")).toBe(false);
    expect(localeTextAccepted("记录显示 mmol/L", "zh-SG")).toBe(true);
  });
});

describe("shell rules ai-shell-rules.11b.8-r3 (content coverage)", () => {
  type Field = "headline" | "observation" | "evidence";
  const at = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  const lexical = (result: unknown) => (result as { lexical?: string[] }).lexical ?? [];
  const expectS5 = (result: unknown, violation: string) => {
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false });
    expect(lexical(result)).toContain(violation);
  };
  const expectS6 = (result: unknown) => expect(result).toEqual({ kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false });
  /** The closed Traditional→Simplified map size, and every zh rule-list character whose Traditional form is the same character. */
  // Rules r5: 19 Traditional characters added for the clinical-label rules (148 → 167), and 13 more in r5 fix round 1
  // (葯 適 難 膽 狀 傷 瀉 悶 氣 輸 開 驗 鍼; 167 → 180); the r3 rows are unchanged.
  // Rules r6: 14 more for the r6 deliberate zh forms and neutral phrases (誤 傳 腎 節 遺 脹 紅 乾 幹 掛 門 團 隊 約; 180 → 194);
  // r6 fix round 1: 6 more for the sibling forms (嚨 絞 腸 濕 溼 癒) and 2 for the neutral 病历 (歷 曆); 194 → 202.
  // r6 fix round 2: 腳 and 蓋 for 脚痛/脚疼 and 膝盖痛/膝盖疼 (202 → 204).
  // Rules r10: six additive rows (观 踪 细 监 让 觉).
  // Rules r11: two additive rows (键 for 关键, 词 for the open 关键词); 210 → 212.
  // Rules r12: 38 additive rows for the r12 claim-shape entries (蠻 穩 擊 選 運 動 鍛 煉 飲 樣 對 實 幫 見 備 顧 帶 溝 討 論 檔 儲 師 現 擁 許 兒 憊 興 喪 煩 獨 擾
  // 滿 輕 鬆 餒 驕); 212 → 250. Rules r12 fix round 1: 剛 (刚才/刚刚 in the F3 person-did window); 250 → 251.
  // Rules r12 fix round 2: 維 (维持); 251 → 252.
  const TRADITIONAL_MAP_SIZE = 252;
  // Rules r10 added 特格外步再家仔神警惕目及察追密人令 (the r10 directive entries); rules r11 added 字 (关键字 stays open) and 容 (the 关键内容 sample).
  // Rules r12 added 相真平控制突凸眼醒散走行活物膳治做助益善效作奏管通自己被替核同士掌握也或概免肯感累疲倦乏焦舒辛苦沮失力怕孤困欣慰委屈灰奈豪傲似乎像解然
  // (the r12 claim-shape entries; each is written the same in Traditional); r12 fix round 1 added 良先此才曾直; fix round 2 added 指促持.
  const SAME_IN_TRADITIONAL = "一七三上下不中之乎乏九也了事二五些交享人什今仔仟令以任份伍似位低住何作你佰依促保修倍倦值偏做健傍傲像先克免全八公六再凌凸出分切利到制刻前力加助包化十千卅午半卡危即原去及可司同善囊四回因困在地增士壹外多夜大天太失奈奏好妨委字存孤它安完定害家容密察射小少就尺屈差己已常平年康建廿引很得微心必忘快忽怕急患您情惕想意感慰成我或所才打批找拜拾持指按挺捌掌控提握摩支收改放效救散整斤新日早明星昨是晚晨更曾替最月有服期未末本杯果柒查柱核格概次欣正此步每比毛毫汞沮治活添漏灰焦然片物特玖理瓶生用由留略疲病百的益盎目直相看真眼碗磅示神秒突立管米粒糖素累考者肆肯胰能膳自致舒良苦落血行表被要解警豪走起超跌跟路身辛近追送通造遍遵都酮醒重量降除零需非食餐高";

  // --- English -------------------------------------------------------------------------------------------------
  it.each([
    "Twenty entries: {{S2}}.", "Twentyone entries: {{S2}}.", "Forty-five entries: {{S2}}.", "Fifty entries: {{S2}}.", "Ninety-nine entries: {{S2}}.",
    "Thirteen entries: {{S2}}.", "Nineteen entries: {{S2}}.", "Zero entries: {{S2}}.", "Nought here: {{S2}}.", "Nil here: {{S2}}.",
    "A hundred entries: {{S2}}.", "Hundreds of entries: {{S2}}.", "Thousands of entries: {{S2}}.", "A thousand entries: {{S2}}.", "Millions of entries: {{S2}}.", "Billions of entries: {{S2}}.",
    "Scores of entries: {{S2}}.", "A dozen entries: {{S2}}.", "A couple of entries: {{S2}}.", "A pair of entries: {{S2}}.",
    "The first entry: {{S2}}.", "The second entry: {{S2}}.", "The third entry: {{S2}}.", "The twelfth entry: {{S2}}.", "The twentieth entry: {{S2}}.", "The ninetieth entry: {{S2}}.", "The hundredth entry: {{S2}}.", "The thousandth entry: {{S2}}.",
    "Noted thrice: {{S2}}.", "A double entry: {{S2}}.", "A triple entry: {{S2}}.", "A quadruple entry: {{S2}}.",
    "Half of your entries: {{S2}}.", "The halves: {{S2}}.", "A quarter of your entries: {{S2}}.", "Quarters: {{S2}}.", "Thirds of your entries: {{S2}}.",
  ])("r3 en NUMBER_WORD: %j is rejected at S5", (text) => expectS5(at("en", "observation", text), "NUMBER_WORD"));
  it.each(["Some percent: {{S2}}.", "Some per cent: {{S2}}.", "Some percent here: {{S2}}.", "A percentage: {{S2}}.", "Percentages: {{S2}}.", "In pct: {{S2}}.", "A percentile: {{S2}}.", "Percentiles: {{S2}}."])("r3 en PERCENT: %j is rejected at S5", (text) => expectS5(at("en", "observation", text), "PERCENT"));
  it.each([
    "In milligrams: {{S2}}.", "In micrograms: {{S2}}.", "In grams: {{S2}}.", "In kilograms: {{S2}}.", "In kilos: {{S2}}.", "In kilo: {{S2}}.",
    "In millimoles: {{S2}}.", "In millimol: {{S2}}.", "In moles: {{S2}}.", "In mol: {{S2}}.",
    "In litres: {{S2}}.", "In liters: {{S2}}.", "In millilitres: {{S2}}.", "In milliliters: {{S2}}.", "In decilitres: {{S2}}.", "In deciliters: {{S2}}.", "In dl: {{S2}}.",
    "In pounds: {{S2}}.", "In ounces: {{S2}}.", "In oz: {{S2}}.", "In stone: {{S2}}.",
    "In centimetres: {{S2}}.", "In centimeters: {{S2}}.", "In metres: {{S2}}.", "In millimetres: {{S2}}.", "In millimeters: {{S2}}.", "In mmHg: {{S2}}.", "In inches: {{S2}}.", "In inch: {{S2}}.",
    "In calories: {{S2}}.", "In kcal: {{S2}}.", "In units: {{S2}}.", "In tablets: {{S2}}.", "In capsules: {{S2}}.", "In puffs: {{S2}}.", "In doses: {{S2}}.", "In dosages: {{S2}}.",
    "In minutes: {{S2}}.", "In mins: {{S2}}.", "In hours: {{S2}}.", "In hrs: {{S2}}.", "In seconds: {{S2}}.",
  ])("r3 en UNIT: %j is rejected at S5", (text) => expectS5(at("en", "observation", text), "UNIT"));
  it.each([
    "In May: {{S2}}.", "In March: {{S2}}.", "On Mon: {{S2}}.", "On Tue: {{S2}}.", "On Tues: {{S2}}.", "On Wed: {{S2}}.", "On Thu: {{S2}}.", "On Thur: {{S2}}.", "On Thurs: {{S2}}.", "On Fri: {{S2}}.", "On Sat: {{S2}}.", "On Sun: {{S2}}.",
    "Over days: {{S2}}.", "Over weeks: {{S2}}.", "Over the weekend: {{S2}}.", "Over a fortnight: {{S2}}.", "Over months: {{S2}}.", "Over the year: {{S2}}.",
    "Daily: {{S2}}.", "Weekly: {{S2}}.", "Fortnightly: {{S2}}.", "Monthly: {{S2}}.", "Yearly: {{S2}}.", "Annual: {{S2}}.", "Annually: {{S2}}.", "Hourly: {{S2}}.",
    "Mornings: {{S2}}.", "In the afternoon: {{S2}}.", "Evenings: {{S2}}.", "At night: {{S2}}.", "Overnight: {{S2}}.", "At noon: {{S2}}.", "At midday: {{S2}}.", "At midnight: {{S2}}.", "At dawn: {{S2}}.", "At dusk: {{S2}}.",
    "In the past week: {{S2}}.", "In the coming month: {{S2}}.", "Seen the other day: {{S2}}.", "Seen recently: {{S2}}.",
  ])("r3 en DATE_OR_TIME: %j is rejected at S5", (text) => expectS5(at("en", "observation", text), "DATE_OR_TIME"));
  it.each([
    "Pls note {{S2}}.", "Plz note {{S2}}.", "PLEASE note {{S2}}.", "You shouldnt skip {{S2}}.", "You ought see {{S2}}.", "You must see {{S2}}.", "You mustnt skip {{S2}}.", "You mustn’t skip {{S2}}.",
    "Everyone needs to see {{S2}}.", "You have to see {{S2}}.", "Everyone has to see {{S2}}.", "Kindly see {{S2}}.", "Let’s look at {{S2}}.",
    "We recommend {{S2}}.", "A recommendation: {{S2}}.", "We suggest {{S2}}.", "We advise on {{S2}}.", "We encourage {{S2}}.", "We urge {{S2}}.", "Consider {{S2}}.", "Try to see {{S2}}.", "Trying to see {{S2}}.",
    "Make sure you see {{S2}}.", "Be sure you see {{S2}}.", "Remember {{S2}}.", "Don’t forget {{S2}}.", "Dont forget {{S2}}.", "DONT FORGET {{S2}}.", "Do not forget {{S2}}.",
    "It is best to see {{S2}}.", "It is important to see {{S2}}.", "It is advisable to see {{S2}}.", "It is wise to see {{S2}}.", "It is essential to see {{S2}}.",
    "It’s best to see {{S2}}.", "It’s important to see {{S2}}.",
    "You may want to see {{S2}}.", "You might wish to see {{S2}}.", "You could like to see {{S2}}.", "You can try {{S2}}.", "Be careful with {{S2}}.",
    "Keep an eye on {{S2}}.", "Keep track of {{S2}}.", "Check with someone about {{S2}}.", "Talk to someone about {{S2}}.", "Speak to someone about {{S2}}.", "Speak with someone about {{S2}}.", "Ask your family about {{S2}}.", "Avoid {{S2}}.",
  ])("r3 en DIRECTIVE: %j is rejected at S6", (text) => expectS6(at("en", "observation", text)));
  it("r3 en DIRECTIVE with \"better\": rejected at S5 first (better is an r1 COMPARATIVE_DIRECTION word); the directive matches too", () => {
    for (const text of ["You had better see {{S2}}.", "It is better to see {{S2}}.", "It's better to see {{S2}}."]) {
      expectS5(at("en", "observation", text), "COMPARATIVE_DIRECTION");
      expect(shellDirectiveViolation(text.replace("{{S2}}", "the item"), "en-SG"), text).toBe(true);
    }
  });
  it.each([
    ["Pl ease note {{S2}}.", "S6", null], ["Pl ea se note {{S2}}.", "S6", null], ["Sug-gest {{S2}}.", "S6", null], ["Rec ommend {{S2}}.", "S6", null], ["Sh.ould see {{S2}}.", "S6", null], ["Re/member {{S2}}.", "S6", null],
    ["Con'sider {{S2}}.", "S6", null], ["Pl_ease note {{S2}}.", "S6", null], ["Ad vise: {{S2}}.", "S6", null],
    ["It is hi_gher at {{S2}}.", "S5", "COMPARATIVE_DIRECTION"], ["It is hi gher at {{S2}}.", "S5", "COMPARATIVE_DIRECTION"], ["It went dec-reased at {{S2}}.", "S5", "COMPARATIVE_DIRECTION"],
    ["Twen ty entries: {{S2}}.", "S5", "NUMBER_WORD"], ["Hun-dred entries: {{S2}}.", "S5", "NUMBER_WORD"], ["Thou.sand entries: {{S2}}.", "S5", "NUMBER_WORD"],
    ["Per-cent: {{S2}}.", "S5", "PERCENT"], ["Some per cen t: {{S2}}.", "S5", "PERCENT"],
    ["In mil-ligrams: {{S2}}.", "S5", "UNIT"], ["In ki lo grams: {{S2}}.", "S5", "UNIT"], ["In k g: {{S2}}.", "S5", "UNIT"],
    ["Seen yes terday: {{S2}}.", "S5", "DATE_OR_TIME"], ["Seen to day: {{S2}}.", "S5", "DATE_OR_TIME"], ["Seen Mo nday: {{S2}}.", "S5", "DATE_OR_TIME"], ["In Ma y: {{S2}}.", "S5", "DATE_OR_TIME"],
    ["Your glu cose records: {{S2}}.", "S5", "MEASURE_NAME"], ["Your in-sulin records: {{S2}}.", "S5", "MEASURE_NAME"], ["Your wei'ght records: {{S2}}.", "S5", "MEASURE_NAME"],
  ] as const)("r3 en visible split %j is rejected at %s (%s)", (text, gate, violation) => {
    const result = at("en", "observation", text);
    if (twoSentences(text)) {
      // A period inside the word makes two sentences: the one-sentence model field rejects it at S4 first; the rule still matches.
      expect(result).toEqual(SENTENCE_BUDGET);
      if (gate === "S6") expect(shellMeaningScan(text, "en-SG", AI_LANGUAGE_COPY.tokenStandIn["en-SG"]).directive).toBe(true);
      else expect(shellLexicalViolations(stripSlotTokens(text, " "), "en-SG", text)).toContain(violation);
      return;
    }
    if (gate === "S6") expectS6(result);
    else expectS5(result, violation!);
  });
  it("r3 en pair-joined candidates: adjacent pairs and triples of letter runs joined by exactly one separator", () => {
    expect(pairJoinedCandidates(["Pl ea se note"])).toEqual(["Plea", "Please", "ease", "easenote", "senote"]);
    expect(pairJoinedCandidates(["a-b_c.d'e/f"])).toEqual(["ab", "abc", "bc", "bcd", "cd", "cde", "de", "def", "ef"]);
    // Two separators, or a separator outside the set, never join.
    expect(pairJoinedCandidates(["a  b, c:d", "Side by side"])).toEqual(["Sideby", "Sidebyside", "byside"]);
    expect(pairJoinedCandidates([])).toEqual([]);
  });

  // --- Chinese -------------------------------------------------------------------------------------------------
  it.each([
    ["五十条记录：{{S2}}。", "NUMBER_WORD"], ["廿条记录：{{S2}}。", "NUMBER_WORD"], ["卅日记录：{{S2}}。", "NUMBER_WORD"], ["百条记录：{{S2}}。", "NUMBER_WORD"], ["上千条记录：{{S2}}。", "NUMBER_WORD"],
    ["万条记录：{{S2}}。", "NUMBER_WORD"], ["亿条记录：{{S2}}。", "NUMBER_WORD"], ["两条记录：{{S2}}。", "NUMBER_WORD"], ["零条记录：{{S2}}。", "NUMBER_WORD"], ["记录了十分钟：{{S2}}。", "NUMBER_WORD"],
    ["三四条记录：{{S2}}。", "NUMBER_WORD"], ["三倍：{{S2}}。", "NUMBER_WORD"], ["三点：{{S2}}。", "NUMBER_WORD"], ["三半：{{S2}}。", "NUMBER_WORD"], ["三成记录：{{S2}}。", "NUMBER_WORD"],
    ["一半记录：{{S2}}。", "NUMBER_WORD"], ["半数记录：{{S2}}。", "NUMBER_WORD"], ["过半记录：{{S2}}。", "NUMBER_WORD"], ["大半记录：{{S2}}。", "NUMBER_WORD"], ["半个记录：{{S2}}。", "NUMBER_WORD"],
    ["半天记录：{{S2}}。", "NUMBER_WORD"], ["半年记录：{{S2}}。", "NUMBER_WORD"], ["半月记录：{{S2}}。", "NUMBER_WORD"], ["半小时记录：{{S2}}。", "NUMBER_WORD"],
    ["一餐记录：{{S2}}。", "NUMBER_WORD"], ["一顿记录：{{S2}}。", "NUMBER_WORD"], ["一杯：{{S2}}。", "NUMBER_WORD"], ["一碗：{{S2}}。", "NUMBER_WORD"], ["一片：{{S2}}。", "NUMBER_WORD"],
    ["一粒：{{S2}}。", "NUMBER_WORD"], ["一颗：{{S2}}。", "NUMBER_WORD"], ["一支：{{S2}}。", "NUMBER_WORD"], ["一瓶：{{S2}}。", "NUMBER_WORD"], ["一包：{{S2}}。", "NUMBER_WORD"],
    ["一小时：{{S2}}。", "NUMBER_WORD"], ["一分钟：{{S2}}。", "NUMBER_WORD"], ["一秒：{{S2}}。", "NUMBER_WORD"], ["一星期：{{S2}}。", "NUMBER_WORD"], ["一礼拜：{{S2}}。", "NUMBER_WORD"],
    ["一号的记录：{{S2}}。", "NUMBER_WORD"], ["一日的记录：{{S2}}。", "NUMBER_WORD"], ["一倍：{{S2}}。", "NUMBER_WORD"],
    ...["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾", "佰", "仟"].map((numeral) => [`${numeral}条记录：{{S2}}。`, "NUMBER_WORD"] as const),
    ["百分之记录：{{S2}}。", "PERCENT"], ["百分比：{{S2}}。", "PERCENT"], ["百分点：{{S2}}。", "PERCENT"], ["个百分点：{{S2}}。", "PERCENT"], ["几成记录：{{S2}}。", "PERCENT"], ["三成记录：{{S2}}。", "PERCENT"],
    ...["毫摩尔", "摩尔", "每升", "毫克", "微克", "公斤", "千克", "公克", "毫升", "厘米", "公分", "公尺", "毫米", "毫米汞柱", "磅", "盎司", "卡路里", "大卡", "千卡", "单位", "片剂", "胶囊", "剂量"].map((unit) => [`记录显示{{S2}}${unit}。`, "UNIT"] as const),
    ...["早上", "早晨", "上午", "中午", "下午", "傍晚", "晚上", "夜里", "半夜", "凌晨", "每天", "每日", "每周", "每月", "每年", "天天", "本月", "本年", "前几天", "前些天", "这几天", "近几天", "上星期", "下星期", "这星期", "周末"].map((word) => [`${word}的记录：{{S2}}。`, "DATE_OR_TIME"] as const),
  ] as const)("r3 zh: %j is rejected at S5 (%s)", (text, violation) => expectS5(at("zh", "observation", text), violation));
  it.each([
    "千万记得{{S2}}。", "记住{{S2}}。", "别忘{{S2}}。", "不要忽视{{S2}}。", "尽量关注{{S2}}。", "应当关注{{S2}}。", "留意{{S2}}。",
    "请注意{{S2}}。", "要注意{{S2}}。", "应注意{{S2}}。", "需注意{{S2}}。", "注意{{S2}}。", "记录显示{{S2}}。注意该项。", "要记得{{S2}}。", "要留意{{S2}}。",
  ].filter((text) => !text.startsWith("千万")))("r3 zh DIRECTIVE: %j is rejected at S6", (text) => {
    if (!twoSentences(text)) return expectS6(at("zh", "observation", text));
    expect(at("zh", "observation", text)).toEqual(SENTENCE_BUDGET);
    expect(shellMeaningScan(text, "zh-SG", AI_LANGUAGE_COPY.tokenStandIn["zh-SG"]).directive).toBe(true);
  });
  it("r3 zh: 千万 is a number word before it is a directive (S5 runs first); directive alone at S6", () => {
    expectS5(at("zh", "observation", "千万记得{{S2}}。"), "NUMBER_WORD");
    expect(shellDirectiveViolation("千万", "zh-SG")).toBe(true);
  });
  it.each([
    ["請關注{{S2}}。", "S6", null], ["建議您記錄{{S2}}。", "S6", null], ["應該關注{{S2}}。", "S6", null], ["務必關注{{S2}}。", "S6", null], ["記得{{S2}}。", "S6", null], ["應注意{{S2}}。", "S6", null],
    ["風險很大：{{S2}}。", "S6", null], ["醫生診斷：{{S2}}。", "S6", null], ["用藥記錄：{{S2}}。", "S6", null], ["{{S2}}導致變化。", "S6", null], ["一切都沒問題：{{S2}}。", "S6", null], ["盡快就醫：{{S2}}。", "S6", null],
    ["上週的記錄：{{S2}}。", "S5", "DATE_OR_TIME"], ["週末的記錄：{{S2}}。", "S5", "DATE_OR_TIME"], ["每週的記錄：{{S2}}。", "S5", "DATE_OR_TIME"], ["晚上的記錄：{{S2}}。", "S5", "DATE_OR_TIME"], ["下個月的記錄：{{S2}}。", "S5", "DATE_OR_TIME"],
    ["兩次記錄：{{S2}}。", "S5", "NUMBER_WORD"], ["三個記錄：{{S2}}。", "S5", "NUMBER_WORD"], ["萬條記錄：{{S2}}。", "S5", "NUMBER_WORD"], ["億條記錄：{{S2}}。", "S5", "NUMBER_WORD"], ["五點：{{S2}}。", "S5", "NUMBER_WORD"], ["十分鐘：{{S2}}。", "S5", "NUMBER_WORD"], ["一顆：{{S2}}。", "S5", "NUMBER_WORD"], ["貳條：{{S2}}。", "S5", "NUMBER_WORD"],
    ["記錄顯示{{S2}}公斤。", "S5", "UNIT"], ["記錄顯示{{S2}}毫摩爾。", "S5", "UNIT"], ["記錄顯示{{S2}}劑量。", "S5", "UNIT"], ["記錄顯示{{S2}}膠囊。", "S5", "UNIT"], ["記錄顯示{{S2}}單位。", "S5", "UNIT"], ["記錄顯示{{S2}}釐米。", "S5", "UNIT"],
    ["數值上漲：{{S2}}。", "S5", "COMPARATIVE_DIRECTION"], ["數值減少：{{S2}}。", "S5", "COMPARATIVE_DIRECTION"], ["數值變差：{{S2}}。", "S5", "COMPARATIVE_DIRECTION"], ["數值惡化：{{S2}}。", "S5", "COMPARATIVE_DIRECTION"],
    ["您的體重：{{S2}}。", "S5", "MEASURE_NAME"], ["胰島素記錄：{{S2}}。", "S5", "MEASURE_NAME"],
  ] as const)("r3 zh Traditional %j is rejected at %s (%s)", (text, gate, violation) => {
    const result = at("zh", "observation", text);
    if (gate === "S6") expect(result).toMatchObject({ kind: "REJECTED", gate: "S6", repairable: false });
    else expectS5(result, violation!);
  });
  it.each([
    ["建、議您記錄{{S2}}。", "S6", null], ["應、該關注{{S2}}。", "S6", null], ["請（注意）{{S2}}。", "S6", null], ["記 住{{S2}}。", "S6", null], ["不、要忽视{{S2}}。", "S6", null], ["留…意{{S2}}。", "S5", "DISALLOWED_CHARACTER"],
    ["百、分、之记录：{{S2}}。", "S5", "PERCENT"], ["记录显示{{S2}}毫、摩、尔。", "S5", "UNIT"], ["早、上的记录：{{S2}}。", "S5", "DATE_OR_TIME"], ["五、十条记录：{{S2}}。", "S5", "NUMBER_WORD"], ["週、末的記錄：{{S2}}。", "S5", "DATE_OR_TIME"],
  ] as const)("r3 zh punctuation split %j is rejected at %s (%s)", (text, gate, violation) => {
    const result = at("zh", "observation", text);
    if (gate === "S6") expect(result).toMatchObject({ kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false });
    else expectS5(result, violation!);
  });

  // --- Controls ------------------------------------------------------------------------------------------------
  it.each([
    ["en", "observation", "Your records show {{S2}}."],
    ["en", "observation", "In your journal, the values are {{S2}}."],
    ["en", "observation", "Side by side, your journal shows {{S2}}."],
    ["en", "observation", "Earlier and recent values in your records: {{S2}}."],
    ["en", "observation", "You’re seeing {{S2}}."],
    ["en", "observation", "I see {{S2}} in your records."],
    ["en", "observation", "These entries come from your journal: {{S2}}."],
    ["en", "observation", "Someone often notes these values: {{S2}}."],
    ["en", "evidence", "This is based on {{S3}}."],
    ["en", "observation", "Later values in this period: {{S2}}."],
    ["en", "observation", "You may see {{S2}} here."],
    ["zh", "observation", "您的记录显示为{{S2}}。"],
    ["zh", "observation", "对照来看，数值是{{S2}}。"],
    ["zh", "observation", "一些记录显示{{S2}}。"],
    ["zh", "observation", "同一时段一直记录的数值是{{S2}}。"],
    ["zh", "observation", "您的记录、整理：{{S2}}。"],
    ["zh", "observation", "这些记录十分清楚：{{S2}}。"],
    ["zh", "observation", "近期记录显示{{S2}}。"],
    ["zh", "observation", "最近的记录显示{{S2}}。"],
    ["zh", "observation", "您的記錄顯示為{{S2}}。"],
    ["zh", "observation", "较早期间和近期的零食记录：{{S2}}。"],
    // r3 fix round 1 controls: 參 reads as 参 (not the numeral 叁); US "meter" is not a unit; 一成不变 is not a percentage.
    ["zh", "observation", "參考記錄顯示{{S2}}。"],
    ["en", "observation", "Your meter records show {{S2}}."],
    ["zh", "observation", "记录一成不变：{{S2}}。"],
    ["zh", "observation", "记录一成不變：{{S2}}。"],
    ["zh", "observation", "您的记录——日常：{{S2}}。"],
    ["zh", "observation", "一样的记录显示{{S2}}。"],
  ] as const)("r3 control (%s %s): %j is accepted end to end", (locale, field, text) => {
    expect(at(locale, field, text).kind).toBe("VALID");
  });
  it("r3 control: every default shell of every plannable fixture is VALID, and every SUCCESS fixture is PLANNED and remote-eligible", () => {
    let planned = 0;
    for (const fixture of PACKET_11_FIXTURES) {
      let entry: ReturnType<typeof plannedFixture> | null = null;
      try { entry = plannedFixture(fixture.id); } catch { entry = null; }
      if (fixture.expectedOutcome === "SUCCESS") {
        expect(entry, fixture.id).not.toBeNull();
        expect(entry!.plan.remote, fixture.id).toEqual({ eligible: true });
      }
      if (!entry) continue;
      planned += 1;
      const bundleOf = entry.plan.taskType === "EXPLAIN_PATTERN" ? bundle : CARE_BUNDLE;
      expect(validateShellCandidate(entry.plan, bundleOf, shellCandidate(entry.plan, defaultShells(entry.plan))), fixture.id).toMatchObject({ kind: "VALID" });
    }
    expect(planned).toBeGreaterThan(0);
  });

  // --- r3 fix round 1 (controller rulings) ---------------------------------------------------------------------
  it("fix round 1: the zh look-alike numeral map reads only a single dash (not adjacent to another dash)", () => {
    expect(shellScanCopies("记录——日常", "zh-SG")).toEqual(["记录--日常", "记录日常", "记录日常"]);
    expect(shellScanCopies("记录-日常", "zh-SG")[2]).toBe("记录一日常");
    expect(shellScanCopies("记录---日常", "zh-SG")[2]).toBe("记录日常");
    for (const text of ["－月的记录显示{{S2}}。", "—月的记录显示{{S2}}。", "―月的记录显示{{S2}}。", "‒月的记录显示{{S2}}。", "记录显示{{S2}}在周－。"]) expectS5(at("zh", "observation", text), "DATE_OR_TIME");
    expectS5(at("zh", "observation", "共—次，记录显示{{S2}}。"), "NUMBER_WORD");
  });
  it("fix round 1: 參 maps to 参; 叁 keeps only 叄 as its Traditional form (both financial numerals stay caught)", () => {
    expect(TRADITIONAL_TO_SIMPLIFIED.get("參")).toBe("参");
    expect(TRADITIONAL_TO_SIMPLIFIED.get("叄")).toBe("叁");
    expectS5(at("zh", "observation", "叄条记录：{{S2}}。"), "NUMBER_WORD");
    expectS5(at("zh", "observation", "叁条记录：{{S2}}。"), "NUMBER_WORD");
  });
  it("fix round 1: US meter(s) is not a unit; metre(s), centimeter(s), millimeter(s) stay units; a glucose meter stays MEASURE_NAME", () => {
    expect(shellLexicalViolations("Your meter and meters show it.", "en-SG")).toEqual([]);
    for (const text of ["In metres: {{S2}}.", "In centimeters: {{S2}}.", "In millimeters: {{S2}}."]) expectS5(at("en", "observation", text), "UNIT");
    expectS5(at("en", "observation", "Your glucose meter records show {{S2}}."), "MEASURE_NAME");
  });
  it.each(["须注意{{S2}}。", "必须注意{{S2}}。", "需注意{{S2}}。", "須注意{{S2}}。", "必須注意{{S2}}。"])("fix round 1: %j is a directive at S6", (text) => expectS6(at("zh", "observation", text)));
  it.each(["一成记录：{{S2}}。", "约一成：{{S2}}。", "一成的记录：{{S2}}。"])("fix round 1: %j is PERCENT at S5 (一成 outside 一成不变)", (text) => expectS5(at("zh", "observation", text), "PERCENT"));

  // --- Traditional Chinese -------------------------------------------------------------------------------------
  /** Every zh list entry (shell lexicon r1/r2/r3, shell DIRECTIVE, legacy meaning rules), as Simplified samples. */
  const ZH_ENTRIES: readonly string[] = [
    // r1/r2 lexicon
    "两者", "二者", "俩", "双", "几次", "多次", "数次", "三次", "两个", "五条", "四项", "三天", "两周", "两年", "三份", "三位", "三种", "两组", "三回", "两遍", "三笔",
    "公斤", "厘米", "毫升", "毫克", "微克",
    "今天", "昨天", "明天", "前天", "后天", "今晚", "昨晚", "上周", "本周", "下周", "这周", "上月", "上个月", "本月", "下月", "下个月", "今年", "去年", "明年", "星期一", "周三", "礼拜天", "三月", "五日", "十号",
    "上升", "下降", "升高", "降低", "增加", "减少", "更高", "更低", "变好", "变差", "好转", "恶化", "上涨", "下跌", "提高", "回落",
    "血糖", "体重", "酮", "胰岛素",
    // DIRECTIVE r1 and r3
    "应该", "应当", "必须", "需要", "请", "建议", "务必", "记得", "最好", "一定要", "不妨", "可以考虑",
    "千万", "记住", "别忘", "不要", "尽量", "留意", "请注意", "要注意", "应注意", "需注意", "须注意", "必须注意", "。注意", "要记得", "要留意",
    // DIRECTIVE r10
    "值得关注", "值得注意", "值得留意", "值得留心", "值得重视", "值得警惕", "值得一提", "值得观察", "值得追踪", "值得跟踪", "值得监测", "值得担忧", "值得仔细观察",
    "留心", "留神", "注意一下", "关注一下", "您注意", "您关注", "您当心", "您警惕", "您重视", "您要小心", "。关注", "。当心", "。警惕",
    "密切关注", "密切观察", "密切监测", "引人注目", "令人担忧", "让人担心", "令人不安", "引起关注", "引起您的重视", "重要", "很重要",
    // r10 tightened before commit (coordinator ruling): modal + attention verb.
    "应关注", "须关注", "需关注", "要关注", "得关注", "多关注", "多加关注", "可以多关注", "您需关注", "您要关注", "您应关注", "应重视", "须警惕", "要留心", "要特别注意", "要多加注意",
    // DIRECTIVE r11
    "重点", "重点是", "关键", "关键内容", "很关键", "显著", "很显著",
    // DIRECTIVE r12 (claim shapes: F1 data judgement, F2 benefit or cause, F3 completed-state claim, F4 attributed feeling)
    "结果很好", "这些记录蛮好", "比较突出的记录", "凸显的内容", "是要点", "记录中的要点", "读数控制得很好", "这些记录很稳定", "数值平稳",
    "散步对您有帮助", "运动对您有益", "锻炼有帮助", "饮食有好处", "运动见效",
    "已经保存", "已发送", "已上传", "保存好了", "已为您储存", "已存档", "护理团队现在有了", "医生拥有", "药剂师已经收到了",
    "您可能会感到", "您可能觉得有点累", "您也许觉得疲惫", "您看起来很烦", "您觉得很轻松", "您觉得满意", "您觉得骄傲", "您觉得有点儿烦",
    "您觉得很高兴", "您觉得沮丧", "您或许会觉得孤独", "您觉得困扰", "您觉得气馁", "感到辛苦是可以理解的",
    // r12 fix round 1 (I2): 良好 / 令人满意 of data, 效果很好, the modal + emotion form and 您辛苦了.
    "读数控制良好", "数值令人满意", "运动效果很好", "您一定很担心", "您可能有些担心", "您辛苦了", "辛苦您了",
    // r12 fix round 2: holder-independent benefit claims.
    "对您的健康有帮助", "有助于维持身体", "该项对您有帮助", "它很有帮助",
    // r3 NUMBER_WORD, PERCENT, UNIT, DATE_OR_TIME
    "五十", "廿", "卅", "百", "千", "万", "亿", "两", "零", "十分钟", "三四", "三成", "五倍", "三点", "三半", "一半", "半数", "过半", "大半", "半个", "半天", "半年", "半月", "半小时",
    "一餐", "两顿", "一杯", "一碗", "一片", "三粒", "一颗", "一支", "一瓶", "一包", "一小时", "五分钟", "十秒", "一星期", "一礼拜", "五号", "三日", "一倍",
    "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾", "佰", "仟",
    "百分之", "百分比", "百分点", "个百分点", "几成", "一成",
    "毫摩尔", "摩尔", "每升", "千克", "公克", "公分", "公尺", "毫米", "毫米汞柱", "磅", "盎司", "卡路里", "大卡", "千卡", "单位", "片剂", "胶囊", "剂量",
    "早上", "早晨", "上午", "中午", "下午", "傍晚", "晚上", "夜里", "半夜", "凌晨", "每天", "每日", "每周", "每月", "每年", "天天", "本年", "前几天", "前些天", "这几天", "近几天", "上星期", "下星期", "这星期", "周末",
    // legacy meaning rules (zh)
    "医生已经看过", "医生会审阅", "医生已收到", "医生确认", "医生批准", "医生检查过", "已经发送给", "已分享给", "已转发给", "已提交给", "我已经更新", "我修改了", "我保存了", "我删除", "我记录了", "我添加了", "我更正了",
    "风险", "危险", "不安全", "有害", "严重", "导致", "原因", "因为", "由于", "造成", "引起", "所以", "归因",
    "偏高", "偏低", "过高", "过低", "太高", "太低", "正常", "异常", "超标", "低血糖", "高血糖", "达标", "在范围内",
    "会继续", "将会", "预计", "预测", "未来", "会上升", "会下降", "会升高", "会降低",
    "诊断", "病情", "表明您", "说明您有", "表明你", "显示出您患", "说明了你是",
    "服用", "服药", "注射", "打针", "吃药", "用药", "调整剂量", "加大用量", "减小胰岛素",
    "漏服", "漏打", "忘记服", "忘记吃", "忘记打", "没有按时", "依从", "遵医嘱",
    "急诊", "立刻", "立即", "马上", "尽快就医", "看医生", "就医", "救护车",
    "结果都好", "情况非常理想", "它们都不错", "这些很安全", "一切都好", "一切正常", "一切顺利", "一切没问题", "都健康", "很安全", "是健康的", "身体很健康", "没有什么问题", "没毛病", "没事", "无碍", "无大碍", "安好", "放心",
    "不用担心", "无需紧张", "不必看医生", "不需要复诊", "没必要就医", "没有必要随访", "用不着跟进", "别检查", "别理会", "别处理", "别找医生",
    "没什么好担心", "没有什么需要担心", "没什么值得担心", "可以忽略", "能安全地不理会", "可以不用理会", "确认没有问题", "确认无异常", "确认不存在风险", "确认没有担忧",
  ];
  const zhCaught = (text: string): string[] => {
    const found: string[] = shellLexicalViolations(text, "zh-SG").filter((entry) => entry !== "DISALLOWED_CHARACTER");
    if (shellDirectiveViolation(text, "zh-SG")) found.push("DIRECTIVE");
    found.push(...new Set(shellScanCopies(text, "zh-SG").flatMap((scan) => meaningMatches(scan).map((rule) => rule.id))));
    return found.sort();
  };
  /** Simplified → every Traditional form (the inverse of the closed map). */
  const inverse = (): Map<string, string[]> => {
    const result = new Map<string, string[]>();
    for (const [traditional, simplified] of TRADITIONAL_TO_SIMPLIFIED) result.set(simplified, [...(result.get(simplified) ?? []), traditional]);
    return result;
  };
  /** The all-first-form Traditional rendering of a sample, plus one variant per alternative Traditional form. */
  const traditionalForms = (text: string): string[] => {
    const forms = inverse();
    const chars = [...text];
    const primary = chars.map((char) => forms.get(char)?.[0] ?? char).join("");
    const variants = chars.flatMap((char, index) => (forms.get(char) ?? []).slice(1).map((alternative) => chars.map((other, position) => (position === index ? alternative : forms.get(other)?.[0] ?? other)).join("")));
    return [primary, ...variants];
  };
  it("r3 Traditional map: a closed, frozen Traditional→Simplified map of the pinned size, every key Traditional-only, every value Simplified", () => {
    expect(TRADITIONAL_TO_SIMPLIFIED.size).toBe(TRADITIONAL_MAP_SIZE);
    for (const [traditional, simplified] of TRADITIONAL_TO_SIMPLIFIED) {
      expect([...traditional], traditional).toHaveLength(1);
      expect([...simplified], simplified).toHaveLength(1);
      expect(traditional).not.toBe(simplified);
      expect(TRADITIONAL_TO_SIMPLIFIED.has(simplified), `${traditional}→${simplified} chains`).toBe(false);
    }
    for (const [traditional, simplified] of [["請", "请"], ["議", "议"], ["應", "应"], ["該", "该"], ["須", "须"], ["務", "务"], ["記", "记"], ["萬", "万"], ["兩", "两"], ["億", "亿"], ["個", "个"], ["條", "条"], ["項", "项"], ["週", "周"], ["組", "组"], ["筆", "笔"], ["種", "种"], ["號", "号"], ["點", "点"], ["時", "时"], ["鐘", "钟"], ["體", "体"], ["島", "岛"], ["風", "风"], ["險", "险"], ["診", "诊"], ["斷", "断"], ["惡", "恶"], ["異", "异"], ["減", "减"], ["變", "变"], ["轉", "转"], ["漲", "涨"], ["釐", "厘"], ["爾", "尔"], ["劑", "剂"], ["藥", "药"], ["醫", "医"], ["療", "疗"], ["確", "确"], ["認", "认"], ["問", "问"], ["題", "题"], ["沒", "没"], ["擔", "担"], ["緊", "紧"], ["張", "张"], ["處", "处"], ["測", "测"], ["將", "将"], ["會", "会"], ["續", "续"], ["繼", "继"], ["預", "预"], ["發", "发"], ["歲", "岁"], ["單", "单"]]) {
      expect(TRADITIONAL_TO_SIMPLIFIED.get(traditional), traditional).toBe(simplified);
    }
  });
  it("r3 Traditional map covers every character of the zh rule lists whose Traditional form differs", () => {
    const sources = [...SHELL_LEXICAL_RULES.map(([, pattern]) => pattern.source), ...SHELL_DIRECTIVE_PATTERNS.map((pattern) => pattern.source), ...SHELL_CLAUSE_DIRECTIVE_PATTERNS.map((pattern) => pattern.source), ...SHELL_R12_SPLIT_CUE_WORDS, ...MEANING_RULES.filter((rule) => rule.locale === "zh").map((rule) => rule.pattern.source), "次个条项天周月年份位种组回遍笔", ZH_ENTRIES.join("")];
    const characters = new Set(sources.join("").match(/[㐀-鿿豈-﫿]/gu) ?? []);
    const covered = new Set(TRADITIONAL_TO_SIMPLIFIED.values());
    // A Traditional character written into a rule (一成不變) is itself a map key and needs no entry.
    const missing = [...characters].filter((char) => !covered.has(char) && !TRADITIONAL_TO_SIMPLIFIED.has(char) && !SAME_IN_TRADITIONAL.includes(char));
    expect(missing).toEqual([]);
    // The classification is exclusive: a character with a listed Traditional form is not also listed as identical.
    expect([...SAME_IN_TRADITIONAL].filter((char) => covered.has(char))).toEqual([]);
  });
  it("r3 Traditional generation: every zh list entry is caught in Simplified, and every Traditional form of it is caught by the same rules", () => {
    let generated = 0;
    for (const entry of ZH_ENTRIES) {
      const simplified = zhCaught(entry);
      expect(simplified, entry).not.toEqual([]);
      for (const traditional of traditionalForms(entry)) {
        if (traditional !== entry) generated += 1;
        expect(zhCaught(traditional), `${entry} → ${traditional}`).toEqual(expect.arrayContaining(simplified));
      }
    }
    expect(generated).toBeGreaterThan(150);
  });
  it("r3 the T→S copies are appended to the zh scan copies only when they differ; displayed text is never rewritten", () => {
    expect(shellScanCopies("建議您看", "zh-SG")).toEqual(["建議您看", "建議您看", "建議您看", "建议您看"]);
    expect(shellScanCopies("建、議", "zh-SG")).toEqual(["建、議", "建議", "建議", "建、议", "建议"]);
    expect(shellScanCopies("您的记录", "zh-SG")).toEqual(["您的记录", "您的记录", "您的记录"]);
    const texts = { ...VALID_ZH, observation: "您的記錄顯示為{{S2}}。" };
    const result = check(ZH.plan, texts);
    expect(result.kind).toBe("VALID");
    expect((result as Extract<typeof result, { kind: "VALID" }>).shells.get("evidence")).toBe("您的記錄顯示為{{S3}}。");
  });
});

describe("shell rules ai-shell-rules.11b.11-r4 (wording quality)", () => {
  type Field = "headline" | "observation" | "evidence";
  const at = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  /** Fix round 1: the r4 wording gate is S7b (run after S7), with the evaluation-only quality detail naming the field kind. */
  // Observation ownership: a case written for the former model observation is replayed as the evidence (asModelFields), so its S7b
  // detail names the evidence.
  const S7B = (fieldKind: "headline" | "observation" | "evidence" | "intro") => ({ kind: "REJECTED", gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false, quality: { code: "NOT_MEANINGFUL", fieldKind: fieldKind === "observation" ? "evidence" : fieldKind } }) as const;
  const REGISTER = { kind: "REJECTED", gate: "S7", reason: "LOCALE_INVALID", repairable: false, register: "INFORMAL_SECOND_PERSON" } as const;
  /** The care plan's default shells with every section intro replaced by `intro` (bullets stay token only). */
  const careWithIntros = (fixtureId: string, intro: string) => careCheck(fixtureId, (plan, texts) => plan.sections.forEach((section) => texts.set(section.introPath, intro)));

  // --- meaningfulWording ---------------------------------------------------------------------------------------
  it.each([
    ["en-SG", "See {{S1}}.", false],
    ["en-SG", "Here: {{S1}}", false],
    ["en-SG", "A {{S1}}.", false],
    ["en-SG", "Okay, so {{S1}}.", false],
    ["en-SG", "OK. Well, yeah, um, uh, hmm, oh, hey, just, yes, no, so {{S1}}.", false],
    ["en-SG", "+ {{S3}}.", false],
    ["en-SG", "{{S1}} {{S2}}", false],
    ["en-SG", "", false],
    ["en-SG", "I a {{S1}} x y.", false],
    ["en-SG", "A look at {{S1}}.", true],
    ["en-SG", "Here is a look at {{S1}}.", true],
    ["en-SG", "Your records show {{S2}}.", true],
    ["en-SG", "This view draws on {{S3}}.", true],
    ["en-SG", "You picked these notes to bring along.", true],
    ["en-SG", "Okay, your records {{S1}}.", true],
    ["zh-SG", "这里看看{{S1}}", false],
    ["zh-SG", "这里看看{{S1}}。", false],
    ["zh-SG", "看看{{S1}}吧", false],
    ["zh-SG", "这里瞧瞧{{S1}}呀。", false],
    ["zh-SG", "说说想想{{S2}}一下嘛。", false],
    ["zh-SG", "嗯，{{S2}}啊，哦，呢，啦。", false],
    ["zh-SG", "記錄說說{{S2}}吧。", false],
    ["zh-SG", "记录显示{{S2}}。", false],
    ["zh-SG", "{{S1}}，。", false],
    ["zh-SG", "Look at your records {{S1}}", false],
    ["zh-SG", "记录里显示{{S2}}。", true],
    ["zh-SG", "以上内容根据{{S3}}整理。", true],
    ["zh-SG", "您选择记录的内容如下。", true],
    ["zh-SG", "这里看的是{{S1}}。", true],
    ["zh-SG", "记录的数值：{{S2}}。", true],
  ] as const)("meaningfulWording(%s, %j) is %s", (locale, text, expected) => {
    expect(meaningfulWording(text, locale)).toBe(expected);
  });
  it.each(["看看", "瞧瞧", "说说", "想想", "一下", "吧", "呢", "啊", "哦", "嗯", "呀", "啦", "嘛"])("the zh filler %j never counts toward the five ideographs", (filler) => {
    // 这里给您 is four ideographs: the filler would make it five or six if it counted.
    expect(meaningfulWording(`这里给您${filler}{{S1}}。`, "zh-SG")).toBe(false);
    expect(meaningfulWording(`这里给您看的{{S1}}。`, "zh-SG")).toBe(true);
  });
  it("zh fillers are also removed on the Traditional→Simplified copy (the smallest count over the scan copies decides)", () => {
    expect(meaningfulWording("這裡給您說說{{S1}}。", "zh-SG")).toBe(false);
    expect(meaningfulWording("這裡給您看的{{S1}}。", "zh-SG")).toBe(true);
  });
  it.each(["ok", "OK", "Okay", "oh", "Hey", "um", "uh", "hmm", "Well", "so", "just", "yeah", "Yes", "no"])("the en filler %j never counts as one of the two words", (filler) => {
    expect(meaningfulWording(`Records ${filler} {{S1}}.`, "en-SG")).toBe(false);
    expect(meaningfulWording(`Records here {{S1}}.`, "en-SG")).toBe(true);
  });
  it("the register rule reads every zh scan copy: a compatibility ideograph folding to 你 is caught by the helper (and the validator already refuses it at S5)", () => {
    expect(shellRegisterViolation("\u{2F804}的记录", "zh-SG")).toBe("INFORMAL_SECOND_PERSON");
    const result = at("zh", "observation", "\u{2F804}的记录显示为{{S2}}。");
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect((result as { lexical?: string[] }).lexical).toContain("DISALLOWED_CHARACTER");
  });
  it("meaningfulWording never counts the token stand-in or the atoms: only the model wording outside the tokens", () => {
    expect(meaningfulWording("{{S1}}{{S2}}{{S3}}{{S4}}{{S5}}", "zh-SG")).toBe(false);
    expect(meaningfulWording("{{S1}} {{S2}}", "en-SG")).toBe(false);
  });

  // --- S7b on every EXPLAIN field ------------------------------------------------------------------------------
  it.each([
    ["zh", "headline", "这里看看{{S1}}"],
    ["zh", "headline", "这里看看{{S1}}。"],
    ["zh", "headline", "看看{{S1}}吧"],
    ["en", "headline", "See {{S1}}."],
    ["en", "headline", "Here: {{S1}}"],
    ["en", "headline", "Okay, so {{S1}}."],
    ["en", "observation", "Values: {{S2}}."],
    ["en", "observation", "Well, {{S2}}."],
    // 11b.18: "+ {{S3}}." has no letter and the evidence is now a presence group, so it is S4b (asserted above); a filler word is S7b.
    ["en", "evidence", "So {{S3}}."],
    ["en", "evidence", "Just {{S3}}."],
    ["zh", "observation", "嗯，{{S2}}啊。"],
    ["zh", "evidence", "基于{{S3}}。"],
    ["zh", "evidence", "记录说说{{S3}}一下吧。"],
  ] as const)("S7b (%s %s): %j is OUTPUT_BUDGET_EXCEEDED, never repairable", (locale, field, text) => {
    expect(at(locale, field, text)).toEqual(S7B(field));
  });
  it.each([
    ["en", { headline: "Here is a look at {{S1}}.", observation: "Your records show {{S2}}.", evidence: "This view draws on {{S3}}." }],
    ["zh", { headline: "这里看的是{{S1}}。", observation: "记录里显示{{S2}}。", evidence: "以上内容根据{{S3}}整理。" }],
  ] as const)("control (%s): the smoke styles are VALID", (locale, texts) => {
    expect(check(locale === "en" ? EN.plan : ZH.plan, texts)).toMatchObject({ kind: "VALID" });
  });

  // --- S7b on every care section intro ------------------------------------------------------------------------
  it.each([
    [CARE_EN, "You picked these notes to bring along."],
    [CARE_ZH, "您选择记录的内容如下。"],
  ])("control (%s): an intro in the smoke style with token-only bullets is VALID", (fixtureId, intro) => {
    expect(careWithIntros(fixtureId, intro)).toMatchObject({ kind: "VALID" });
  });
  it.each([
    [CARE_EN, "Okay, so."],
    [CARE_EN, "Notes:"],
    [CARE_ZH, "嗯，看看吧。"],
    [CARE_ZH, "以下内容："],
  ])("S7b (%s): an intro %j without meaningful wording rejects the whole result", (fixtureId, intro) => {
    expect(careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro))).toEqual(S7B("intro"));
  });
  it("fix round 1: a symbol-only intro beside token-only bullets has no letter in its section, so the earlier presence gate S4b rejects it", () => {
    expect(careCheck(CARE_EN, (plan, texts) => texts.set(plan.sections[0]!.introPath, "+"))).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
  });
  it.each([[CARE_EN, "Here is what you chose to include: "], [CARE_ZH, "这里是您选择加入的内容："]])("S7b (%s): words in the bullets never rescue a filler intro", (fixtureId, prefix) => {
    const result = careCheck(fixtureId, (plan, texts) => {
      const section = plan.sections[0]!;
      texts.set(section.introPath, fixtureId === CARE_EN ? "Okay, so." : "嗯，看看吧。");
      for (const path of section.bulletPaths) texts.set(path, `${prefix}${texts.get(path)}`);
    });
    expect(result).toEqual(S7B("intro"));
  });
  it.each([
    // The schema refuses an empty intro (structural, so repairable once under the bundle; a second failure falls back).
    ["empty", "", "S2"],
    ["punctuation only", "：。", "S4"],
    ["a token only", "{{S1}}", "S3"],
    ["a look-alike token only", "{{…}}", "S3"],
  ])("an intro that is %s is rejected (%s)", (_label, intro, gate) => {
    for (const fixtureId of [CARE_EN, CARE_ZH]) {
      const result = careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro));
      expect(result, fixtureId).toMatchObject({ kind: "REJECTED", gate });
      if (gate !== "S2") expect(result, fixtureId).toMatchObject({ repairable: false });
    }
  });
  it.each([
    ["zh", "这这这这这{{S1}}。"],
    ["zh", "的的的的的{{S1}}。"],
    ["zh", "这里这里这里{{S1}}。"],
    ["en", "The the {{S1}}."],
  ] as const)("fix round 2: thresholds count distinct units — %s %j is rejected at S7b", (locale, text) => {
    expect(meaningfulWording(text, locale === "en" ? "en-SG" : "zh-SG")).toBe(false);
    expect(at(locale, "headline", text)).toEqual(S7B("headline"));
  });
  it("fix round 2: distinct counting — five different ideographs or two different words pass; repeats count once", () => {
    expect(meaningfulWording("这里看的是{{S1}}。", "zh-SG")).toBe(true);
    expect(meaningfulWording("这里这里看的是{{S1}}。", "zh-SG")).toBe(true);
    expect(meaningfulWording("这里这里看的{{S1}}。", "zh-SG")).toBe(false);
    expect(meaningfulWording("Your records {{S1}}.", "en-SG")).toBe(true);
    expect(meaningfulWording("Records RECORDS records {{S1}}.", "en-SG")).toBe(false);
  });
  it("the earlier four-ideograph controls pass S1–S7 and are rejected only by the r4 wording gate (S7b, run last)", () => {
    for (const text of ["记录、整理：{{S2}}。", "记录——日常：{{S2}}。"]) {
      expect(at("zh", "observation", text), text).toEqual(S7B("observation"));
      expect(at("zh", "observation", `您的${text}`).kind, text).toBe("VALID");
    }
  });
  it("fix round 1: the gate labels are in execution order and only S7b carries the quality detail", () => {
    // Rules r5 inserts S6b (clinical labels) between S6 and S7; the r4 labels and their order are otherwise unchanged.
    expect(SHELL_GATE_ORDER).toEqual(["S1", "S2", "S2a", "S3", "S4", "S4b", "S5", "S6", "S6b", "S7", "S7b"]);
    expect(Object.isFrozen(SHELL_GATE_ORDER)).toBe(true);
    // The presence stage keeps S4b (before S5) and carries no quality detail.
    expect(at("en", "headline", "★ {{S1}}")).toEqual({ kind: "REJECTED", gate: "S4b", reason: "OUTPUT_BUDGET_EXCEEDED", repairable: false });
    expect(at("zh", "observation", "你的记录显示为{{S2}}。")).not.toHaveProperty("quality");
    expect(at("en", "headline", "See {{S1}}.")).toEqual(S7B("headline"));
    expect(at("zh", "headline", "这里看看{{S1}}")).toEqual(S7B("headline"));
  });
  it("the r4 wording stage never masks a fact, meaning or locale rejection: short violating text keeps its S5, S6 or S7 gate", () => {
    expect(at("zh", "observation", "注意{{S2}}。")).toEqual({ kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false });
    expect(at("en", "observation", "Please {{S2}}.")).toEqual({ kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false });
    expect(at("en", "observation", "Higher {{S2}}.")).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect(at("zh", "observation", "两次：{{S2}}。")).toMatchObject({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED" });
    expect(at("zh", "observation", "您的 records show {{S2}} here.")).toEqual({ kind: "REJECTED", gate: "S7", reason: "LOCALE_INVALID", repairable: false });
    expect(at("zh", "headline", "你看{{S1}}。")).toEqual(REGISTER);
  });
  it("care bullets may stay fact only: every default care shell (token-only bullets) is VALID", () => {
    for (const fixtureId of [CARE_EN, CARE_ZH]) {
      const { plan } = plannedFixture(fixtureId);
      expect(plan.fields.filter((field) => field.path.includes("bullets")).every((field) => field.mayBeAtomOnly), fixtureId).toBe(true);
      expect(validateShellCandidate(plan, CARE_BUNDLE, shellCandidate(plan, defaultShells(plan))), fixtureId).toMatchObject({ kind: "VALID" });
    }
  });
  it("every approved default shell of all 70 fixtures still passes S1–S10", () => {
    expect(PACKET_11_HYBRID_FIXTURES).toHaveLength(70);
    // Fix round 2: every one of the 70 fixtures is planned and checked (no vacuous pass).
    let plannedCount = 0;
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const bundleOf = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
      const planned = planSlots(fixture.request, bundleOf);
      if (planned.kind !== "PLANNED") continue;
      plannedCount += 1;
      const shellTexts = defaultShells(planned.plan);
      for (const field of planned.plan.fields) {
        const meaningful = field.path === "headline" || field.path === "observation" || field.path === "evidence" || field.path.endsWith("intro");
        if (meaningful) expect(meaningfulWording(shellTexts.get(field.path)!, planned.plan.locale), `${fixture.id} ${field.path}`).toBe(true);
      }
      const result = validateShellCandidate(planned.plan, bundleOf, shellCandidate(planned.plan, shellTexts));
      expect(result, fixture.id).toMatchObject({ kind: "VALID" });
      const assembled = assembleAi(fixture.request, planned.plan, planned.atoms, (result as Extract<typeof result, { kind: "VALID" }>).shells, bundleOf);
      if (assembled.kind !== "ASSEMBLED") throw new Error(`${fixture.id} ${assembled.reason}`);
      expect(verifyComposition(fixture.request, bundleOf, assembled.composition), fixture.id).toMatchObject({ kind: "ACCEPTED" });
    }
    expect(plannedCount).toBe(70);
  });

  // --- S7 register (zh-SG) -------------------------------------------------------------------------------------
  it.each([
    ["headline", "这里是你选的{{S1}}。"],
    ["observation", "你的记录显示为{{S2}}。"],
    ["evidence", "以上内容基于你的{{S3}}。"],
    ["observation", "妳的记录显示为{{S2}}。"],
    ["observation", "你们的记录显示为{{S2}}。"],
    ["observation", "妳們的记录显示为{{S2}}。"],
    ["observation", "你的記錄顯示為{{S2}}。"],
    ["observation", "您的记录显示为{{S2}}，你看。"],
  ] as const)("S7 register (zh %s): %j is LOCALE_INVALID with register INFORMAL_SECOND_PERSON", (field, text) => {
    expect(at("zh", field, text)).toEqual(REGISTER);
  });
  it("S7 register: a care section intro with 你 is rejected; the 您 form is VALID", () => {
    expect(careWithIntros(CARE_ZH, "你选择记录的内容如下。")).toEqual(REGISTER);
    expect(careWithIntros(CARE_ZH, "您选择记录的内容如下。")).toMatchObject({ kind: "VALID" });
  });
  it("S7 register: 您 is accepted; en-SG is unaffected; other S7 rejections and VALID results carry no register", () => {
    expect(at("zh", "observation", "您的记录显示为{{S2}}。")).toMatchObject({ kind: "VALID" });
    expect(at("zh", "observation", "您的记录显示为{{S2}}。")).not.toHaveProperty("register");
    expect(at("en", "observation", "You’re seeing {{S2}}.")).toMatchObject({ kind: "VALID" });
    expect(at("zh", "observation", "记录的数值 in the journal：{{S2}}。")).toEqual({ kind: "REJECTED", gate: "S7", reason: "LOCALE_INVALID", repairable: false });
    expect(shellRegisterViolation("你的记录", "zh-SG")).toBe("INFORMAL_SECOND_PERSON");
    expect(shellRegisterViolation("妳們", "zh-SG")).toBe("INFORMAL_SECOND_PERSON");
    expect(shellRegisterViolation("您的记录", "zh-SG")).toBeNull();
    expect(shellRegisterViolation("你", "en-SG")).toBeNull();
    expect(shellRegisterViolation("You picked these notes", "en-SG")).toBeNull();
  });
  it("fact atoms are never scanned or altered: a patient question with 你 assembles, passes the unchanged r7 validator and is displayed byte-identical", () => {
    const base = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === CARE_ZH)!;
    const request = asHybridRequest(structuredClone(base.request));
    const question = "医生，你觉得我可以把笔放在包里吗？";
    (request.facts as any[]).find((fact) => fact.field === "QUESTION_TEXT").value.text = question;
    const planned = planSlots(request, CARE_BUNDLE);
    if (planned.kind !== "PLANNED") throw new Error("expected PLANNED");
    const quoted = Object.values(planned.atoms).find((entry) => entry!.text.includes(question))!.text;
    expect(quoted).toContain("你");
    const shellTexts = new Map(defaultShells(planned.plan));
    for (const section of planned.plan.sections) shellTexts.set(section.introPath, "您选择记录的内容如下。");
    const validated = validateShellCandidate(planned.plan, CARE_BUNDLE, shellCandidate(planned.plan, shellTexts));
    expect(validated).toMatchObject({ kind: "VALID" });
    const assembled = assembleComposition(request, planned.plan, planned.atoms, (validated as Extract<typeof validated, { kind: "VALID" }>).shells, CARE_BUNDLE);
    if (assembled.kind !== "ASSEMBLED") throw new Error(`expected ASSEMBLED, got ${assembled.reason}`);
    expect([...assembled.composition.fields.values()].some((field) => field.text.includes(quoted))).toBe(true);
    expect(verifyComposition(request, CARE_BUNDLE, assembled.composition)).toMatchObject({ kind: "ACCEPTED" });
    const deterministic = composeDeterministic(request, planned.plan, planned.atoms, CARE_BUNDLE);
    expect([...deterministic.fields.values()].some((field) => field.text.includes(quoted))).toBe(true);
  });
});

describe("shell rules ai-shell-rules.11b.12-r5 (clinical labels)", () => {
  type Field = "headline" | "observation" | "evidence";
  type Category = "DISEASE_OR_CONDITION" | "DIAGNOSIS" | "SYMPTOM" | "MEDICATION" | "TREATMENT" | "CLINICAL_LABEL";
  const at = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  /** The r5 clinical-label gate S6b: CLINICAL_MEANING_VIOLATION, never repairable, with the evaluation-only category. */
  const S6B = (clinicalLabel: Category) => ({ kind: "REJECTED", gate: "S6b", reason: "CLINICAL_MEANING_VIOLATION", repairable: false, clinicalLabel }) as const;
  const S6 = { kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false } as const;
  const s5 = (violation: string) => ({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: expect.arrayContaining([violation]) });
  const careWithIntro = (fixtureId: string, intro: string) => careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro));

  /** Every required en entry (brief r5), by category; multi-word entries and inflections included. */
  const EN_ENTRIES: ReadonlyArray<readonly [Category, readonly string[]]> = [
    ["DISEASE_OR_CONDITION", ["disease", "diseases", "illness", "illnesses", "condition", "conditions", "disorder", "disorders", "syndrome", "syndromes", "chronic", "diabetes", "diabetic", "diabetics", "prediabetes", "prediabetic", "hypertension", "hypertensive", "hypotension", "cancer", "cancers", "tumour", "tumours", "tumor", "tumors", "infection", "infections", "infected", "infectious", "asthma", "stroke", "strokes", "heart attack", "heart attacks", "heart disease", "kidney disease", "obesity", "obese", "anaemia", "anemia", "depression", "anxiety", "dementia", "epilepsy", "arthritis", "hyperglycaemia", "hyperglycemia", "hypoglycaemia", "hypoglycemia", "high blood pressure", "blood sugar"]],
    ["DIAGNOSIS", ["diagnosis", "diagnoses", "diagnosed", "diagnose", "diagnostic"]],
    ["SYMPTOM", ["symptom", "symptoms", "symptomatic", "pain", "pains", "painful", "ache", "aches", "fever", "cough", "headache", "headaches", "dizziness", "dizzy", "nausea", "vomiting", "fatigue", "rash", "swelling", "bleeding", "shortness of breath"]],
    ["MEDICATION", ["medication", "medications", "medicine", "medicines", "medicinal", "drug", "drugs", "pill", "pills", "tablet", "tablets", "capsule", "capsules", "dose", "doses", "dosage", "insulin", "prescription", "prescriptions", "prescribed", "antibiotic", "antibiotics", "injection", "injections"]],
    // Rules r6 removes "treat", "treated" and "treating" (and "treats"); treatment(s), untreated, treatable and therapy stay.
    ["TREATMENT", ["treatment", "treatments", "therapy", "therapies", "surgery", "surgical"]],
    ["CLINICAL_LABEL", ["clinical", "medical", "pathology", "prognosis"]],
    // r5 fix round 1 (controller ruling): additions.
    ["DISEASE_OR_CONDITION", ["sick", "sickness", "unwell", "flu", "influenza", "allergy", "allergies", "allergic", "cholesterol", "thyroid", "heart failure", "cardiac", "renal", "COPD", "inflammation", "inflamed", "injury", "injuries", "injured", "migraine", "migraines", "seizure", "seizures", "insomnia", "complications", "relapse", "remission", "flare-up", "mental health", "psychiatric", "overweight", "covid"]],
    ["SYMPTOM", ["constipation", "diarrhoea", "diarrhea", "cramp", "cramps", "palpitations", "breathless", "breathlessness", "wheezing", "sore"]],
    ["MEDICATION", ["side effect", "side effects", "vaccine", "vaccines", "vaccination", "inhaler", "inhalers", "overdose", "meds"]],
    ["TREATMENT", ["chemo", "chemotherapy", "radiotherapy", "physiotherapy", "physio", "rehab", "rehabilitation", "postoperative", "untreated", "treatable"]],
    // r5 fix round 1: any letters before the stems therap-, diagnos-, diabet-, hypertens-, cancer-, infect- and medicat-.
    ["DISEASE_OR_CONDITION", ["antihypertensive", "nondiabetic", "precancerous", "reinfection", "infect", "infects", "noninfectious"]],
    ["DIAGNOSIS", ["undiagnosed", "misdiagnosed", "prediagnosis"]],
    ["MEDICATION", ["medicated", "medicate", "medicating", "premedication"]],
    ["TREATMENT", ["psychotherapy", "hydrotherapist"]],
  ];
  /**
   * Every required zh entry (Simplified), by category. Rules r6 replaces the r5 single-character entries 诊 病 炎 症 痛 疼 疗 治 晕
   * 咳 肿 呕 剂 疾 药 and the bare 点滴 with deliberate multi-character forms (癌 stays: it is always cancer); every r5
   * multi-character entry is kept.
   */
  const ZH_CLINICAL_ENTRIES: ReadonlyArray<readonly [Category, readonly string[]]> = [
    ["DISEASE_OR_CONDITION", ["疾病", "病情", "生病", "患病", "发病", "病史", "病毒", "病症", "慢性病", "传染病", "心脏病", "肾病", "糖尿病", "糖尿", "癌", "炎症", "发炎", "肺炎", "关节炎", "胃炎", "肝炎", "皮炎", "并发症", "后遗症", "抑郁症", "焦虑症", "痴呆症", "失智症", "肿瘤"]],
    ["DISEASE_OR_CONDITION", ["高血压", "低血压", "感染", "哮喘", "中风", "抑郁", "忧郁", "焦虑", "痴呆", "失智", "癫痫", "肥胖", "贫血", "血糖"]],
    ["DIAGNOSIS", ["诊断", "确诊", "误诊", "漏诊", "诊治"]],
    ["SYMPTOM", ["症状", "疼痛", "头痛", "胃痛", "腹痛", "胸痛", "背痛", "腰痛", "牙痛", "酸痛", "关节痛", "头疼", "肚子疼", "头晕", "眩晕", "晕厥", "晕倒", "咳嗽", "咳痰", "干咳", "肿胀", "水肿", "红肿", "浮肿", "呕吐", "干呕", "发烧", "发热", "恶心", "出血", "疲劳", "乏力", "皮疹", "身体不适"]],
    ["MEDICATION", ["药物", "用药", "服药", "吃药", "药片", "药丸", "药品", "西药", "中药", "降压药", "降糖药", "止痛药", "抗生素", "药剂", "针剂", "片剂", "剂量", "胰岛素", "处方", "注射", "胶囊"]],
    ["TREATMENT", ["治疗", "医治", "根治", "救治", "治病", "疗法", "疗程", "疗效", "化疗", "放疗", "理疗", "手术"]],
    ["CLINICAL_LABEL", ["临床", "医学"]],
    // r5 fix round 1 (controller ruling): additions (r6: the bare 点滴 is replaced by 打点滴 and 挂点滴).
    ["DISEASE_OR_CONDITION", ["血压高", "患有", "罹患", "患者", "感冒", "流感", "过敏", "胆固醇", "甲状腺", "失眠", "骨折", "受伤", "复发"]],
    ["SYMPTOM", ["不适", "难受", "不舒服", "抽筋", "心悸", "麻木", "发冷", "拉肚子", "腹泻", "便秘", "胸闷", "气喘"]],
    ["MEDICATION", ["副作用", "疫苗", "接种", "输液", "打点滴", "挂点滴", "吊针"]],
    ["TREATMENT", ["开刀", "住院", "康复", "复健", "化验", "医嘱", "针灸"]],
  ];
  const EN_FLAT = EN_ENTRIES.flatMap(([category, words]) => words.map((word) => [category, word] as const));
  const ZH_FLAT = ZH_CLINICAL_ENTRIES.flatMap(([category, words]) => words.map((word) => [category, word] as const));
  /** The en entries an earlier gate already rejects in the observation "Your <word> notes show {{S2}}." (r1–r4 unchanged). */
  const EN_EARLIER: Readonly<Record<string, unknown>> = {
    "blood sugar": s5("MEASURE_NAME"), insulin: s5("MEASURE_NAME"),
    tablet: s5("UNIT"), tablets: s5("UNIT"), capsule: s5("UNIT"), capsules: s5("UNIT"), dose: s5("UNIT"), doses: s5("UNIT"), dosage: s5("UNIT"),
    diagnosis: S6, diagnoses: S6, diagnosed: S6, diagnose: S6, diagnostic: S6,
    hyperglycaemia: S6, hyperglycemia: S6, hypoglycaemia: S6, hypoglycemia: S6, injection: S6, injections: S6,
    // r5 fix round 1 had "flare-up" here (S5 COMPARATIVE_DIRECTION, bare "up"). Rules r7 removes bare up/down from the r1 entry and
    // "flare" is no direction verb, so "Your flare-up notes show {{S2}}." now reaches S6b (DISEASE_OR_CONDITION): still rejected.
  };
  /** The zh entries an earlier gate already rejects in the observation "您的<entry>记录显示为{{S2}}。". */
  const ZH_EARLIER: Readonly<Record<string, unknown>> = {
    血糖: s5("MEASURE_NAME"), 胰岛素: s5("MEASURE_NAME"), 胶囊: s5("UNIT"), 片剂: s5("UNIT"),
    诊断: S6, 注射: S6,
    // Rules r6 forms that the unchanged earlier gates already reject (S5 unit word 剂量; S6 legacy meaning rules).
    剂量: s5("UNIT"), 病情: S6, 用药: S6, 服药: S6, 吃药: S6,
  };

  // --- gate order, closed lists ----------------------------------------------------------------------------------
  it("pins the rules revision (r12 since 11b.18; r11 since 11b.17; r10 since 11b.16, with the r9 refinement; r8 since 11b.15; r6 in 11b.13) and the gate order with S6b after S5 and S6 and before S7", () => {
    expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12");
    expect(SHELL_GATE_ORDER).toEqual(["S1", "S2", "S2a", "S3", "S4", "S4b", "S5", "S6", "S6b", "S7", "S7b"]);
    expect(Object.isFrozen(SHELL_GATE_ORDER)).toBe(true);
  });
  it("the clinical-label categories and rules are closed, frozen and non-global", () => {
    expect(CLINICAL_LABEL_CATEGORIES).toEqual(["DISEASE_OR_CONDITION", "DIAGNOSIS", "SYMPTOM", "MEDICATION", "TREATMENT", "CLINICAL_LABEL"]);
    expect(Object.isFrozen(CLINICAL_LABEL_CATEGORIES) && Object.isFrozen(CLINICAL_LABEL_RULES)).toBe(true);
    expect(new Set(CLINICAL_LABEL_RULES.map(([category]) => category))).toEqual(new Set(CLINICAL_LABEL_CATEGORIES));
    for (const [category, pattern] of CLINICAL_LABEL_RULES) {
      expect(Object.isFrozen(pattern), category).toBe(true);
      expect(pattern.global || pattern.sticky, category).toBe(false);
    }
  });

  // --- the lexicon ---------------------------------------------------------------------------------------------
  it.each(EN_FLAT)("en %s: %j is a clinical label (helper, any case)", (category, word) => {
    expect(shellClinicalLabel(`Your ${word} notes`, "en-SG")).toBe(category);
    expect(shellClinicalLabel(`Your ${word.toUpperCase()} notes`, "en-SG")).toBe(category);
    expect(shellClinicalLabel(`${word[0]!.toUpperCase()}${word.slice(1)} notes`, "en-SG")).toBe(category);
  });
  it.each(ZH_FLAT)("zh %s: %j is a clinical label (helper)", (category, entry) => {
    expect(shellClinicalLabel(`您的${entry}记录`, "zh-SG")).toBe(category);
  });
  it.each(EN_FLAT)("en %s: %j in a model-written observation falls back (S6b, or the earlier gate that already rejects it)", (category, word) => {
    expect(at("en", "observation", `Your ${word} notes show {{S2}}.`)).toEqual(EN_EARLIER[word] ?? S6B(category));
  });
  it.each(ZH_FLAT)("zh %s: %j in a model-written observation falls back (S6b, or the earlier gate that already rejects it)", (category, entry) => {
    expect(at("zh", "observation", `您的${entry}记录显示为{{S2}}。`)).toEqual(ZH_EARLIER[entry] ?? S6B(category));
  });
  it("en entries are word-bounded: a listed word inside a longer neutral word is not a label", () => {
    for (const text of ["Your painting notes", "Your treaty notes", "A spill of notes", "Your conditional notes", "The drugstore list", "Pilling notes", "Your medicalisation"]) {
      expect(shellClinicalLabel(text, "en-SG"), text).toBeNull();
    }
  });

  it("r5 fix round 1: BP, DM, HTN and operation are not added; the prefix rule keeps other entries word-bounded", () => {
    for (const text of ["Your BP notes", "Your DM notes", "Your HTN notes", "The operation of this view", "Your painting notes", "Your conditional notes", "Your treaty notes", "Your druggist list"]) expect(shellClinicalLabel(text, "en-SG"), text).toBeNull();
    expect(at("en", "observation", "Your BP and HTN notes show {{S2}}.")).toMatchObject({ kind: "VALID" });
  });
  it("r5 fix round 1: the prefixed stems are rejected at S6b in a model-written observation", () => {
    for (const [word, category] of [["antihypertensive", "DISEASE_OR_CONDITION"], ["undiagnosed", "DIAGNOSIS"], ["misdiagnosed", "DIAGNOSIS"], ["nondiabetic", "DISEASE_OR_CONDITION"], ["precancerous", "DISEASE_OR_CONDITION"], ["reinfection", "DISEASE_OR_CONDITION"], ["medicated", "MEDICATION"], ["infects", "DISEASE_OR_CONDITION"], ["psychotherapy", "TREATMENT"]] as const) {
      expect(at("en", "observation", `Your ${word} notes show {{S2}}.`), word).toEqual(S6B(category));
    }
  });
  /**
   * The r5 strict false positives (pinned in r5 fix round 1) are accepted under rules r6 (owner instruction 2026-10-06): neutral
   * logistics phrases are masked, single-character zh stems and "treat" are gone and en joins must equal a listed word. Only
   * "under similar conditions" stays a hit: "condition(s)" is kept as a complete word by the r6 ruling.
   */
  it.each([
    ["zh-SG", "您的门诊预约"], ["zh-SG", "复诊安排"], ["zh-SG", "就诊记录"], ["zh-SG", "诊所地址"], ["zh-SG", "候诊时间"], ["zh-SG", "看诊记录"],
    ["zh-SG", "医疗团队"], ["zh-SG", "医疗记录"], ["zh-SG", "药房"], ["zh-SG", "病历"], ["zh-SG", "生活点滴"],
    ["en-SG", "your medical team"], ["en-SG", "a medical appointment"], ["en-SG", "your GP surgery"], ["en-SG", "a treat after dinner"], ["en-SG", "the rapid view"],
  ] as const)("r5 false positive accepted under r6 (%s): %j carries no clinical label", (locale, text) => {
    expect(shellClinicalLabel(text, locale)).toBeNull();
  });
  it("r6 keeps \"condition(s)\" as a complete word: \"under similar conditions\" is still a hit (fail closed)", () => {
    expect(shellClinicalLabel("under similar conditions", "en-SG")).toBe("DISEASE_OR_CONDITION");
  });

  // --- neutral controls ------------------------------------------------------------------------------------------
  it.each([
    ["en-SG", "your records"], ["en-SG", "your notes"], ["en-SG", "this summary"], ["en-SG", "care team"], ["en-SG", "measurement"], ["en-SG", "readings you chose to include"],
    ["en-SG", "You picked these notes to bring along."], ["en-SG", "Your records show {{S2}}."], ["en-SG", "This view draws on {{S3}}."], ["en-SG", "Here is a look at {{S1}}."],
    ["zh-SG", "您的记录"], ["zh-SG", "您的备注"], ["zh-SG", "这份摘要"], ["zh-SG", "护理团队"], ["zh-SG", "测量"],
    ["zh-SG", "记录里显示{{S2}}。"], ["zh-SG", "以上内容根据{{S3}}整理。"], ["zh-SG", "您选择记录的内容如下。"], ["zh-SG", "这里看的是{{S1}}。"],
    // r5 fix round 1: further neutral controls.
    ["en-SG", "appointment"], ["en-SG", "clinic"], ["en-SG", "doctor"], ["en-SG", "health check"], ["en-SG", "pharmacy"],
    ["zh-SG", "预约"], ["zh-SG", "医生"], ["zh-SG", "体检"], ["zh-SG", "护理计划"], ["zh-SG", "睡眠"], ["zh-SG", "心情"],
  ] as const)("neutral control (%s): %j carries no clinical label", (locale, text) => {
    expect(shellClinicalLabel(stripSlotTokens(text, " "), locale)).toBeNull();
  });
  it.each([
    ["en", { headline: "Here is a look at {{S1}}.", observation: "Your records show {{S2}}.", evidence: "This view draws on {{S3}}." }],
    ["zh", { headline: "这里看的是{{S1}}。", observation: "记录里显示{{S2}}。", evidence: "以上内容根据{{S3}}整理。" }],
  ] as const)("neutral control (%s): the smoke-style EXPLAIN shells stay VALID through S1–S10", (locale, texts) => {
    const planned = locale === "en" ? EN : ZH;
    const result = check(planned.plan, texts);
    expect(result).toMatchObject({ kind: "VALID" });
    expect(result).not.toHaveProperty("clinicalLabel");
    const assembled = assembleAi(planned.request, planned.plan, planned.atoms, (result as Extract<typeof result, { kind: "VALID" }>).shells, bundle);
    if (assembled.kind !== "ASSEMBLED") throw new Error(assembled.reason);
    expect(verifyComposition(planned.request, bundle, assembled.composition)).toMatchObject({ kind: "ACCEPTED" });
  });
  it.each([[CARE_EN, "You picked these notes to bring along."], [CARE_ZH, "您选择记录的内容如下。"], [CARE_EN, "Notes for your clinic appointment and health check are here."], [CARE_EN, "Your doctor and pharmacy notes are here."], [CARE_ZH, "您的预约和体检内容如下。"], [CARE_ZH, "您的睡眠和心情记录如下。"], [CARE_ZH, "您给医生看的护理计划如下。"]])("neutral control (%s): the care intro %j stays VALID", (fixtureId, intro) => {
    expect(careCheck(fixtureId, (plan, texts) => plan.sections.forEach((section) => texts.set(section.introPath, intro)))).toMatchObject({ kind: "VALID" });
  });

  // --- S6b in every field ----------------------------------------------------------------------------------------
  it("S6b scans every EXPLAIN field, every care intro and every care bullet; the result carries only the category detail", () => {
    expect(at("en", "headline", "Your diabetes notes at {{S1}}.")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(at("en", "observation", "Your medication records show {{S2}}.")).toEqual(S6B("MEDICATION"));
    expect(at("en", "evidence", "This symptom view draws on {{S3}}.")).toEqual(S6B("SYMPTOM"));
    expect(at("zh", "headline", "这里看的是您糖尿病的{{S1}}。")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(at("zh", "evidence", "以上治疗内容根据{{S3}}整理。")).toEqual(S6B("TREATMENT"));
    expect(careWithIntro(CARE_EN, "Your diabetes notes are listed here.")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(careWithIntro(CARE_ZH, "您选择记录的药物内容如下。")).toEqual(S6B("MEDICATION"));
    expect(careCheck(CARE_EN, (plan, texts) => texts.set(plan.sections[0]!.bulletPaths[0]!, `Clinical note: ${texts.get(plan.sections[0]!.bulletPaths[0]!)}`))).toEqual(S6B("CLINICAL_LABEL"));
    expect(careCheck(CARE_ZH, (plan, texts) => texts.set(plan.sections[0]!.bulletPaths[0]!, `症状：${texts.get(plan.sections[0]!.bulletPaths[0]!)}`))).toEqual(S6B("SYMPTOM"));
  });
  it("S6b is never repairable although the bundle allows a structural repair, and no other result carries clinicalLabel", () => {
    expect(bundle.executionBudget.structuralRepairAllowed).toBe(true);
    expect(at("en", "observation", "Your diabetes notes show {{S2}}.")).toMatchObject({ repairable: false });
    expect(at("en", "observation", "Your records show {{S2}}.")).not.toHaveProperty("clinicalLabel");
    expect(at("en", "observation", "Please see {{S2}}.")).not.toHaveProperty("clinicalLabel");
    expect(at("en", "headline", "See {{S1}}.")).not.toHaveProperty("clinicalLabel");
    expect(at("zh", "observation", "你的记录显示为{{S2}}。")).not.toHaveProperty("clinicalLabel");
  });
  it("S6b runs after S5 and S6 (they keep their gate) and before S7 and S7b (it wins over them)", () => {
    expect(at("en", "observation", "Your diabetes notes rose: {{S2}}.")).toEqual(s5("COMPARATIVE_DIRECTION"));
    expect(at("en", "observation", "Please see your diabetes notes {{S2}}.")).toEqual(S6);
    expect(at("en", "observation", "Your diabetes notes show {{S2}} as too high.")).toEqual(S6);
    expect(at("zh", "observation", "您的糖尿病记录 in the journal：{{S2}}。")).toEqual(S6B("DISEASE_OR_CONDITION"));
    // Rules r6: 病历 is no longer a label, so the S6b-before-S7 case uses 疾病.
    expect(at("zh", "observation", "你的疾病记录{{S2}}。")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(at("en", "headline", "Diabetes {{S1}}.")).toEqual(S6B("DISEASE_OR_CONDITION"));
    // Rules r6: the bare 药 is no longer a label, so the S6b-before-S7b case uses 药物.
    expect(at("zh", "headline", "看看药物{{S1}}吧")).toEqual(S6B("MEDICATION"));
  });
  it("the first failing field in plan order decides the category, and the first category in the closed order within a field", () => {
    expect(check(EN.plan, { headline: "A medication look at {{S1}}.", observation: "Your diabetes records show {{S2}}.", evidence: "This is based on {{S3}}." })).toEqual(S6B("MEDICATION"));
    expect(at("en", "observation", "Your medication and diabetes notes show {{S2}}.")).toEqual(S6B("DISEASE_OR_CONDITION"));
    // Rules r6: 病历 is no longer a label; 疾病 keeps the closed-order case.
    expect(at("zh", "observation", "您的药物和疾病记录{{S2}}。")).toEqual(S6B("DISEASE_OR_CONDITION"));
  });
  it("the displayed shell text is never rewritten by the scan copies", () => {
    const result = at("zh", "observation", "您的記錄顯示為{{S2}}。");
    expect((result as Extract<typeof result, { kind: "VALID" }>).shells.get("evidence")).toBe("您的記錄顯示為{{S3}}。");
  });

  // --- bypasses --------------------------------------------------------------------------------------------------
  it.each([
    ["case", "Your DIABETES notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["case", "Diabetes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["typographic hyphen U+2010", "Your dia‐betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["non-breaking hyphen U+2011", "Your dia‑betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["en dash", "Your dia–betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["no-break space", "Your dia betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["typographic apostrophe", "Your dia’betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["visible split (space)", "Your dia betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["visible split (hyphen)", "Your dia-betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["visible split (underscore)", "Your dia_betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["visible split (slash)", "Your dia/betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["visible split (period)", "Your dia.betes notes show {{S2}}.", "DISEASE_OR_CONDITION"],
    ["three-run split", "Your me di cation notes show {{S2}}.", "MEDICATION"],
    ["three-run split (hyphens)", "Your me-di-cation notes show {{S2}}.", "MEDICATION"],
    ["look-alike rn for m", "Your rnedication notes show {{S2}}.", "MEDICATION"],
    ["look-alike I for l", "Your cIinical notes show {{S2}}.", "CLINICAL_LABEL"],
  ] as const)("bypass (%s): %j is rejected at S6b", (_label, text, category) => {
    if (twoSentences(text)) {
      expect(at("en", "observation", text)).toEqual(SENTENCE_BUDGET);
      expect(shellClinicalLabel(stripSlotTokens(text, CLINICAL_TOKEN_SEPARATOR), "en-SG")).toBe(category);
      return;
    }
    expect(at("en", "observation", text)).toEqual(S6B(category));
  });
  it.each([
    ["Traditional 糖尿病 (same form)", "您的糖尿病记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["Traditional 高血壓", "您的高血壓记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["Traditional 藥物", "您的藥物记录显示为{{S2}}。", S6B("MEDICATION")],
    ["Traditional 腫瘤", "您的腫瘤记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["Traditional 頭暈", "您的頭暈记录显示为{{S2}}。", S6B("SYMPTOM")],
    ["Traditional 臨床", "您的臨床记录显示为{{S2}}。", S6B("CLINICAL_LABEL")],
    // r5 fix round 1: the variant 葯 and Traditional forms of the additions.
    ["variant 葯", "您的葯物记录显示为{{S2}}。", S6B("MEDICATION")],
    ["Traditional 膽固醇", "您的膽固醇记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["Traditional 不適", "您的不適记录显示为{{S2}}。", S6B("SYMPTOM")],
    ["Traditional 醫囑", "您的醫囑记录显示为{{S2}}。", S6B("TREATMENT")],
    ["Traditional 鍼灸", "您的鍼灸记录显示为{{S2}}。", S6B("TREATMENT")],
    ["punctuation split 副、作、用", "您的副、作、用记录显示为{{S2}}。", S6B("MEDICATION")],
    // An earlier gate already catches these Traditional forms (legacy meaning rules 用药 and 诊断 at S6).
    ["Traditional 用藥 (S6 medication action first)", "您的用藥记录显示为{{S2}}。", S6],
    ["Traditional 診斷 (S6 diagnosis first)", "您的診斷记录显示为{{S2}}。", S6],
    ["punctuation split 糖、尿、病", "您的糖、尿、病记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["punctuation split 药／物", "您的药／物记录显示为{{S2}}。", S6B("MEDICATION")],
    ["punctuation split 糖、尿 (only the joined copy matches)", "您的糖、尿记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["punctuation split 高、血、压 (only the joined copy matches)", "您的高、血、压记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["space split 失 智", "您的失 智记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["Traditional and split 高、血、壓", "您的高、血、壓记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["full-width Latin in zh (NFKC)", "您的ｄｉａｂｅｔｅｓ记录显示为{{S2}}。", S6B("DISEASE_OR_CONDITION")],
    ["a slot token between the parts", "您的糖{{S2}}尿记录。", S6B("DISEASE_OR_CONDITION")],
  ] as const)("bypass zh (%s): %j", (_label, text, expected) => {
    expect(at("zh", "observation", text)).toEqual(expected);
  });
  it("zero-width and full-width en bypasses are already rejected at S5 (format character, disallowed original)", () => {
    expect(at("en", "observation", "Your dia​betes notes show {{S2}}.")).toEqual(s5("FORMAT_CHARACTER"));
    expect(at("zh", "observation", "您的糖​尿记录显示为{{S2}}。")).toEqual(s5("FORMAT_CHARACTER"));
    expect(at("en", "observation", "Your ｄｉａｂｅｔｅｓ notes show {{S2}}.")).toEqual(s5("DISALLOWED_CHARACTER"));
    // The helper still reads the folded copy (format characters removed, NFKC applied).
    expect(shellClinicalLabel("Your dia​betes notes", "en-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("Your ｄｉａｂｅｔｅｓ notes", "en-SG")).toBe("DISEASE_OR_CONDITION");
  });
  it("split depths: two and three letter runs joined by exactly one separator are caught; deeper or wider splits are a known limit", () => {
    expect(shellClinicalLabel("dia betes", "en-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("di a betes", "en-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("me di cation", "en-SG")).toBe("MEDICATION");
    // Four or more runs, or a separator of two characters, are not joined (the r3 pair/triple-join limits, unchanged).
    expect(shellClinicalLabel("di a be tes", "en-SG")).toBeNull();
    expect(shellClinicalLabel("m e di cation", "en-SG")).toBeNull();
    expect(shellClinicalLabel("dia  betes", "en-SG")).toBeNull();
    expect(shellClinicalLabel("dia, betes", "en-SG")).toBeNull();
    // zh joins every punctuation, symbol or whitespace run between ideographs, at any depth.
    expect(shellClinicalLabel("癫 、 痫", "zh-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("胰、岛、素", "zh-SG")).toBe("MEDICATION");
  });

  // --- Traditional map ---------------------------------------------------------------------------------------------
  /** Every character of the r5 zh clinical-label rules whose Traditional form is the same character. */
  // Fix round 1 appends the same-form characters of the additions.
  // Rules r6 appends the same-form characters of the r6 deliberate forms (and 合 宜 of the 不适 exclusion).
  const R5_SAME_IN_TRADITIONAL = "病疾癌糖尿高血低感染炎瘤哮喘中抑焦呆失智肥胖痛疼咳心出疲乏力皮疹胰素方射囊片治手" + "患有罹者不受舒服冒流敏固醇甲腺眠骨折抽筋悸麻木冷拉肚子腹便秘胸副作用疫苗接液滴吊刀住院康健化灸" + "情生史毒慢性肺胃肝背腰牙酸眩厥倒嗽痰水浮吐身物丸品西降止抗量打根救法程效放理合宜漏" + "腿喉嗓昏鼻咽支管人重膏配好" + "膝";
  it("r5 Traditional map covers every character of the clinical-label rules whose Traditional form differs", () => {
    const characters = new Set(CLINICAL_LABEL_RULES.map(([, pattern]) => pattern.source).join("").match(/[㐀-鿿豈-﫿]/gu) ?? []);
    const covered = new Set(TRADITIONAL_TO_SIMPLIFIED.values());
    expect([...characters].filter((char) => !covered.has(char) && !TRADITIONAL_TO_SIMPLIFIED.has(char) && !R5_SAME_IN_TRADITIONAL.includes(char))).toEqual([]);
    expect([...R5_SAME_IN_TRADITIONAL].filter((char) => covered.has(char))).toEqual([]);
    for (const [traditional, simplified] of [["藥", "药"], ["診", "诊"], ["療", "疗"], ["斷", "断"], ["癥", "症"], ["壓", "压"], ["發", "发"], ["燒", "烧"], ["熱", "热"], ["腫", "肿"], ["頭", "头"], ["暈", "晕"], ["嘔", "呕"], ["噁", "恶"], ["憂", "忧"], ["鬱", "郁"], ["慮", "虑"], ["臟", "脏"], ["風", "风"], ["處", "处"], ["劑", "剂"], ["癡", "痴"], ["癲", "癫"], ["癇", "痫"], ["貧", "贫"], ["勞", "劳"], ["術", "术"], ["臨", "临"], ["學", "学"], ["牀", "床"], ["膠", "胶"], ["島", "岛"], ["確", "确"], ["醫", "医"], ["葯", "药"], ["適", "适"], ["難", "难"], ["膽", "胆"], ["狀", "状"], ["傷", "伤"], ["瀉", "泻"], ["悶", "闷"], ["氣", "气"], ["輸", "输"], ["開", "开"], ["驗", "验"], ["鍼", "针"], ["針", "针"], ["囑", "嘱"], ["種", "种"], ["過", "过"], ["復", "复"]]) {
      expect(TRADITIONAL_TO_SIMPLIFIED.get(traditional), traditional).toBe(simplified);
    }
  });
  it("r5 Traditional generation: every zh clinical entry, and every Traditional form of it, has the same category", () => {
    const forms = new Map<string, string[]>();
    for (const [traditional, simplified] of TRADITIONAL_TO_SIMPLIFIED) forms.set(simplified, [...(forms.get(simplified) ?? []), traditional]);
    let generated = 0;
    for (const [category, entry] of ZH_FLAT) {
      const chars = [...entry];
      const variants = [chars.map((char) => forms.get(char)?.[0] ?? char).join(""), ...chars.flatMap((char, index) => (forms.get(char) ?? []).slice(1).map((alternative) => chars.map((other, position) => (position === index ? alternative : forms.get(other)?.[0] ?? other)).join("")))];
      for (const variant of variants) {
        if (variant !== entry) generated += 1;
        expect(shellClinicalLabel(`您的${variant}记录`, "zh-SG"), `${entry} → ${variant}`).toBe(category);
      }
    }
    expect(generated).toBeGreaterThan(20);
  });

  // --- atoms are never scanned: a verbatim patient question with a clinical label --------------------------------
  it.each([
    [CARE_EN, "Can we talk about my diabetes medication and the knee pain?"],
    [CARE_EN, "Is my insulin dose causing the dizziness?"],
    [CARE_ZH, "我的糖尿病药物需要调整吗？"],
    [CARE_ZH, "最近头晕和咳嗽，可以一起问问吗？"],
  ])("fact atoms are never scanned (%s): the question %j assembles, the unchanged r7 validator accepts it and it is displayed byte-identical", (fixtureId, question) => {
    const base = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === fixtureId)!;
    const request = asHybridRequest(structuredClone(base.request));
    (request.facts as any[]).find((fact) => fact.field === "QUESTION_TEXT").value.text = question;
    const planned = planSlots(request, CARE_BUNDLE);
    if (planned.kind !== "PLANNED") throw new Error("expected PLANNED");
    const quoted = Object.values(planned.atoms).find((entry) => entry!.text.includes(question))!.text;
    expect(shellClinicalLabel(quoted, planned.plan.locale)).not.toBeNull();
    const validated = validateShellCandidate(planned.plan, CARE_BUNDLE, shellCandidate(planned.plan, defaultShells(planned.plan)));
    expect(validated).toMatchObject({ kind: "VALID" });
    const assembled = assembleComposition(request, planned.plan, planned.atoms, (validated as Extract<typeof validated, { kind: "VALID" }>).shells, CARE_BUNDLE);
    if (assembled.kind !== "ASSEMBLED") throw new Error(`expected ASSEMBLED, got ${assembled.reason}`);
    expect([...assembled.composition.fields.values()].some((field) => field.text.includes(quoted))).toBe(true);
    // Recorded (brief r5): the unchanged r7 validator accepts each of these quotes; r7 was not changed.
    expect(verifyComposition(request, CARE_BUNDLE, assembled.composition)).toMatchObject({ kind: "ACCEPTED" });
    const deterministic = composeDeterministic(request, planned.plan, planned.atoms, CARE_BUNDLE);
    expect([...deterministic.fields.values()].some((field) => field.text.includes(quoted))).toBe(true);
  });

  // --- approved default wording ------------------------------------------------------------------------------------
  /**
   * The exact default-wording exceptions to S6b among the 70 fixtures (fixture id, field path, category). None: no fixture
   * plans a MEDICATION_RECORDS section. Any new failure fails this test.
   */
  const DEFAULT_FIXTURE_EXCEPTIONS: ReadonlyArray<readonly [string, string, Category]> = [];
  it("every approved default shell of all 70 fixtures passes S1–S10, except the enumerated S6b exceptions (none)", () => {
    expect(PACKET_11_HYBRID_FIXTURES).toHaveLength(70);
    const found: Array<readonly [string, string, Category]> = [];
    let plannedCount = 0;
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const bundleOf = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
      const planned = planSlots(fixture.request, bundleOf);
      if (planned.kind !== "PLANNED") continue;
      plannedCount += 1;
      const shellTexts = defaultShells(planned.plan);
      const exceptions = planned.plan.fields.flatMap((field) => {
        const category = shellClinicalLabel(stripSlotTokens(shellTexts.get(field.path)!, " "), planned.plan.locale);
        return category ? [[fixture.id, field.path, category] as const] : [];
      });
      found.push(...exceptions);
      const result = validateShellCandidate(planned.plan, bundleOf, shellCandidate(planned.plan, shellTexts));
      if (exceptions.length > 0) {
        expect(result, fixture.id).toEqual(S6B(exceptions[0]![2]));
        continue;
      }
      expect(result, fixture.id).toMatchObject({ kind: "VALID" });
      const assembled = assembleAi(fixture.request, planned.plan, planned.atoms, (result as Extract<typeof result, { kind: "VALID" }>).shells, bundleOf);
      if (assembled.kind !== "ASSEMBLED") throw new Error(`${fixture.id} ${assembled.reason}`);
      expect(verifyComposition(fixture.request, bundleOf, assembled.composition), fixture.id).toMatchObject({ kind: "ACCEPTED" });
    }
    expect(plannedCount).toBe(70);
    expect(found).toEqual(DEFAULT_FIXTURE_EXCEPTIONS);
  });
  it("approved copy: every care intro and EXPLAIN default carries no clinical label, except exactly the medication-records intro (both locales)", () => {
    const found: Array<readonly [string, string, Category]> = [];
    for (const [sectionId, byLocale] of Object.entries(AI_LANGUAGE_COPY.careIntros)) {
      for (const [locale, intro] of Object.entries(byLocale) as Array<["en-SG" | "zh-SG", string]>) {
        const category = shellClinicalLabel(intro, locale);
        if (category) found.push([sectionId, locale, category]);
      }
    }
    for (const [locale, templates] of Object.entries(AI_LANGUAGE_COPY.explainDefaults) as Array<["en-SG" | "zh-SG", Record<string, string>]>) {
      for (const [key, template] of Object.entries(templates)) expect(shellClinicalLabel(template.replace(/\{[a-z]+\}/g, " "), locale), `${locale} ${key}`).toBeNull();
    }
    expect(found).toEqual([["MEDICATION_RECORDS", "en-SG", "MEDICATION"], ["MEDICATION_RECORDS", "zh-SG", "MEDICATION"]]);
  });
  it("ruling: a model intro echoing the medication-records heading or its approved intro falls back (no exception for model wording)", () => {
    expect(careWithIntro(CARE_EN, AI_LANGUAGE_COPY.careIntros.MEDICATION_RECORDS!["en-SG"])).toEqual(S6B("MEDICATION"));
    expect(careWithIntro(CARE_ZH, AI_LANGUAGE_COPY.careIntros.MEDICATION_RECORDS!["zh-SG"])).toEqual(S6B("MEDICATION"));
    expect(careWithIntro(CARE_EN, "Medication records are listed here.")).toEqual(S6B("MEDICATION"));
    expect(careWithIntro(CARE_ZH, "以下是用药记录的内容。")).toEqual(S6);
  });
  it("the slot plans, atoms and deterministic compositions of all 70 fixtures are unchanged by r5 (digest pinned before r5; bundle keys normalised)", () => {
    const replacer = (_key: string, value: unknown) => (value instanceof Map ? [...value.entries()] : value);
    const rows = PACKET_11_HYBRID_FIXTURES.map((fixture) => {
      const bundleOf = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
      const planned = planSlots(fixture.request, bundleOf);
      if (planned.kind !== "PLANNED") return [fixture.id, planned];
      // Presentation correction P1 (ai-language-copy.11b.8, 2026-10-08): the default item wording and item quotation marks changed on
      // purpose; with the 11b.7 default item wording restored and no item quotes, every composition must still equal the pre-r5 digest.
      const legacy = structuredClone(AI_LANGUAGE_COPY) as any;
      legacy.explainDefaults["en-SG"].items = "Recorded items: {items}.";
      legacy.explainDefaults["zh-SG"].items = "记录的项目：{items}。";
      legacy.quotes = { "en-SG": ["", ""], "zh-SG": ["", ""] };
      return [fixture.id, planned.plan, planned.atoms, composeDeterministic(fixture.request, planned.plan, planned.atoms, bundleOf, legacy)];
    });
    // Observation ownership (ai-slot-plan.11b.8) adds only the field owner and the plan version: both are normalised away. Packet 11C
    // phase 2 moved the plan version again (11b.9, eligibility accounting only); it is normalised to the same 11b.7 reference.
    const text = JSON.stringify(rows, replacer).replace(/@11b\.\d+/g, "@BUNDLE").replace(/,"owner":"(?:REMOTE|LOCAL)"/g, "").replaceAll("ai-slot-plan.11b.9", "ai-slot-plan.11b.7");
    expect(createHash("sha256").update(text).digest("hex")).toBe("ab33b2e66822afe51cab5d1dd70f8a47357a0620f0fb3df27f8d5fbdbf8d2077");
  });
});

describe("shell rules ai-shell-rules.11b.13-r6 (clinical-label boundary precision)", () => {
  type Field = "headline" | "observation" | "evidence";
  type Category = "DISEASE_OR_CONDITION" | "DIAGNOSIS" | "SYMPTOM" | "MEDICATION" | "TREATMENT" | "CLINICAL_LABEL";
  const at = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  const S6B = (clinicalLabel: Category) => ({ kind: "REJECTED", gate: "S6b", reason: "CLINICAL_MEANING_VIOLATION", repairable: false, clinicalLabel }) as const;
  const S6 = { kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false } as const;
  const s5 = (violation: string) => ({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: expect.arrayContaining([violation]) });
  const careWithIntro = (fixtureId: string, intro: string) => careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro));
  const EN_WORDS = () => CLINICAL_LABEL_CATEGORIES.flatMap((category) => CLINICAL_LABEL_ENTRIES[category].en);

  // --- revision, gate, closed lists ------------------------------------------------------------------------------
  it("pins the current rules (r12 since 11b.18; r11 since 11b.17; r10 since 11b.16, with the r9 refinement; r8 since 11b.15; r6 lists unchanged); S6b keeps its position, reason, non-repairability and category detail", () => {
    expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12");
    expect(SHELL_GATE_ORDER).toEqual(["S1", "S2", "S2a", "S3", "S4", "S4b", "S5", "S6", "S6b", "S7", "S7b"]);
    expect(at("en", "observation", "Your diabetes notes show {{S2}}.")).toEqual(S6B("DISEASE_OR_CONDITION"));
  });
  it("the neutral phrase list is closed, exact and frozen", () => {
    expect(CLINICAL_NEUTRAL_PHRASES).toEqual({
      en: ["care team", "medical team", "medical appointment", "clinic", "doctor", "pharmacy", "GP surgery"],
      // Fix round 1: 病历 (an administrative record) joins the zh neutral list.
      zh: ["护理团队", "医生", "预约", "诊所", "门诊", "复诊", "就诊", "医疗团队", "药房", "体检", "病历"],
    });
    expect(Object.isFrozen(CLINICAL_NEUTRAL_PHRASES) && Object.isFrozen(CLINICAL_NEUTRAL_PHRASES.en) && Object.isFrozen(CLINICAL_NEUTRAL_PHRASES.zh)).toBe(true);
  });
  it("the entry lists are closed and frozen: en entries are complete words or exact phrases, zh entries are deliberate forms (癌 the only single character)", () => {
    expect(Object.keys(CLINICAL_LABEL_ENTRIES)).toEqual([...CLINICAL_LABEL_CATEGORIES]);
    expect(Object.isFrozen(CLINICAL_LABEL_ENTRIES)).toBe(true);
    for (const category of CLINICAL_LABEL_CATEGORIES) {
      const { en, zh } = CLINICAL_LABEL_ENTRIES[category];
      expect(Object.isFrozen(CLINICAL_LABEL_ENTRIES[category]) && Object.isFrozen(en) && Object.isFrozen(zh), category).toBe(true);
      for (const word of en) expect(word, category).toMatch(/^[a-z]+(?:[ -][a-z]+)*$/);
      for (const form of zh) expect([...form].length > 1 || form === "癌", `${category} ${form}`).toBe(true);
      expect(new Set(en).size, category).toBe(en.length);
      expect(new Set(zh).size, category).toBe(zh.length);
    }
    // One en and one zh pattern per category, in category order; no stem, no [a-z]* prefix or suffix, no \w.
    expect(CLINICAL_LABEL_RULES.map(([category]) => category)).toEqual(CLINICAL_LABEL_CATEGORIES.flatMap((category) => [category, category]));
    for (const [category, pattern] of CLINICAL_LABEL_RULES) {
      expect(pattern.source, category).not.toContain("[a-z]*");
      expect(pattern.source, category).not.toContain("\\w");
      expect(pattern.global || pattern.sticky, category).toBe(false);
    }
  });
  it("the prefixed clinical words are listed explicitly; treat, treated, treating (and treats) are removed; the other r5 words stay", () => {
    const words = EN_WORDS();
    for (const word of ["antihypertensive", "antihypertensives", "nondiabetic", "prediabetes", "prediabetic", "undiagnosed", "misdiagnosed", "misdiagnosis", "precancerous", "reinfection", "chemotherapy", "radiotherapy", "physiotherapy", "psychotherapy", "medicate", "medicated", "medicating", "infect", "infects", "infecting"]) expect(words, word).toContain(word);
    for (const word of ["treat", "treated", "treating", "treats"]) expect(words, word).not.toContain(word);
    for (const word of ["treatment", "treatments", "untreated", "treatable", "therapy", "therapies", "condition", "conditions", "medical", "surgery"]) expect(words, word).toContain(word);
  });

  // --- item 1: complete words only --------------------------------------------------------------------------------
  it.each([
    ["antihypertensives", "DISEASE_OR_CONDITION"], ["nondiabetic", "DISEASE_OR_CONDITION"], ["prediabetes", "DISEASE_OR_CONDITION"], ["prediabetic", "DISEASE_OR_CONDITION"],
    ["undiagnosed", "DIAGNOSIS"], ["misdiagnosed", "DIAGNOSIS"], ["misdiagnosis", "DIAGNOSIS"], ["precancerous", "DISEASE_OR_CONDITION"], ["reinfection", "DISEASE_OR_CONDITION"],
    ["chemotherapy", "TREATMENT"], ["radiotherapy", "TREATMENT"], ["physiotherapy", "TREATMENT"], ["psychotherapy", "TREATMENT"],
    ["medicate", "MEDICATION"], ["medicated", "MEDICATION"], ["medicating", "MEDICATION"], ["infect", "DISEASE_OR_CONDITION"], ["infects", "DISEASE_OR_CONDITION"], ["infecting", "DISEASE_OR_CONDITION"],
    ["treatment", "TREATMENT"], ["untreated", "TREATMENT"], ["treatable", "TREATMENT"], ["therapies", "TREATMENT"], ["side-effects", "MEDICATION"], ["flare-ups", "DISEASE_OR_CONDITION"],
  ] as const)("r6 explicit entry %j is a %s (any case)", (word, category) => {
    expect(shellClinicalLabel(`Your ${word} notes`, "en-SG")).toBe(category);
    expect(shellClinicalLabel(`YOUR ${word.toUpperCase()} NOTES`, "en-SG")).toBe(category);
  });
  it.each(["a treat after dinner", "Treat yourself to a walk.", "Meals treated as snacks", "Treating the notes as a list", "Small treats", "the rapid view", "Your Cancerian notes", "Your painting notes", "Your conditional notes", "Your medicalisation"])(
    "r6 complete words only: %j carries no clinical label (no stem, prefix, suffix or substring match)", (text) => {
      expect(shellClinicalLabel(text, "en-SG")).toBeNull();
    });
  it("r6: a space in a listed phrase reads any whitespace run (labels and neutral phrases alike)", () => {
    expect(shellClinicalLabel("Your high  blood\tpressure notes", "en-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("Your heart\n attack notes", "en-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("Your medical  team notes", "en-SG")).toBeNull();
  });
  it("r6: a Latin word inside zh-SG text is matched as a complete word too", () => {
    expect(shellClinicalLabel("您的diabetes记录", "zh-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("您的Cancerian记录", "zh-SG")).toBeNull();
    expect(shellClinicalLabel("您的GP surgery预约", "zh-SG")).toBeNull();
  });

  // --- item 2: intentional splits ----------------------------------------------------------------------------------
  it.each([
    ["dia betes", "DISEASE_OR_CONDITION"], ["dia-betes", "DISEASE_OR_CONDITION"], ["dia_betes", "DISEASE_OR_CONDITION"], ["me di cation", "MEDICATION"], ["Dia.betes", "DISEASE_OR_CONDITION"], ["the rapy", "TREATMENT"],
    ["DIA BETES", "DISEASE_OR_CONDITION"], ["me dical", "CLINICAL_LABEL"], ["sur gery", "TREATMENT"],
  ] as const)("r6 split %j reconstructs a listed word and is rejected at S6b", (split, category) => {
    expect(shellClinicalLabel(`Your ${split} notes`, "en-SG")).toBe(category);
    const text = `Your ${split} notes show {{S2}}.`;
    expect(at("en", "observation", text)).toEqual(twoSentences(text) ? SENTENCE_BUDGET : S6B(category));
  });
  it("r6 split across a slot token: dia{{S2}}betes is rejected at S6b (tokens are replaced by a separator)", () => {
    expect(at("en", "observation", "Your dia{{S2}}betes notes.")).toEqual(S6B("DISEASE_OR_CONDITION"));
  });
  it("r6: a joined reconstruction that is not exactly a listed word is not a hit (the rapid → therapid)", () => {
    for (const text of ["the rapid view", "Your medi caid notes", "Your can cerebral notes"]) expect(shellClinicalLabel(text, "en-SG"), text).toBeNull();
    expect(at("en", "observation", "Here is the rapid view of {{S2}}.")).toMatchObject({ kind: "VALID" });
  });

  // --- item 3: neutral logistics phrases ---------------------------------------------------------------------------
  it.each(["care team", "medical team", "medical appointment", "clinic", "doctor", "pharmacy", "GP surgery", "MEDICAL TEAM", "Gp Surgery", "Medical Appointment"])(
    "r6 neutral en phrase %j carries no clinical label and stays VALID in a model-written observation", (phrase) => {
      expect(shellClinicalLabel(`Your ${phrase} notes`, "en-SG")).toBeNull();
      expect(at("en", "observation", `Your ${phrase} notes show {{S2}}.`)).toMatchObject({ kind: "VALID" });
    });
  it.each(["护理团队", "医生", "预约", "诊所", "门诊", "复诊", "就诊", "医疗团队", "药房", "体检"])(
    "r6 neutral zh phrase %j carries no clinical label and stays VALID in a model-written observation", (phrase) => {
      expect(shellClinicalLabel(`您的${phrase}记录`, "zh-SG")).toBeNull();
      expect(at("zh", "observation", `您的${phrase}记录显示为{{S2}}。`)).toMatchObject({ kind: "VALID" });
    });
  it("r6 neutral phrases in Traditional forms are masked through the T→S copy", () => {
    for (const text of ["醫療團隊", "護理團隊", "門診", "診所", "複診", "就診", "藥房", "預約", "醫生", "體檢"]) expect(shellClinicalLabel(`您的${text}記錄`, "zh-SG"), text).toBeNull();
    for (const [traditional, simplified] of [["誤", "误"], ["傳", "传"], ["腎", "肾"], ["節", "节"], ["遺", "遗"], ["脹", "胀"], ["紅", "红"], ["乾", "干"], ["幹", "干"], ["掛", "挂"], ["門", "门"], ["團", "团"], ["隊", "队"], ["約", "约"]]) {
      expect(TRADITIONAL_TO_SIMPLIFIED.get(traditional), traditional).toBe(simplified);
    }
  });
  it("r6 neutral care intros stay VALID", () => {
    for (const [fixtureId, intro] of [[CARE_EN, "Notes for your medical appointment and GP surgery are here."], [CARE_EN, "Your care team and medical team notes are here."], [CARE_ZH, "您在门诊和诊所的复诊预约如下。"], [CARE_ZH, "您给医疗团队和医生看的就诊内容如下。"], [CARE_ZH, "您的药房和体检安排如下。"]] as const) {
      expect(careWithIntro(fixtureId, intro), intro).toMatchObject({ kind: "VALID" });
    }
  });
  it("r6: standalone medical and surgery stay hits, and so do forms the neutral list does not name", () => {
    expect(shellClinicalLabel("Your medical notes", "en-SG")).toBe("CLINICAL_LABEL");
    expect(shellClinicalLabel("Your surgery notes", "en-SG")).toBe("TREATMENT");
    expect(at("en", "observation", "Your medical notes show {{S2}}.")).toEqual(S6B("CLINICAL_LABEL"));
    expect(at("en", "observation", "Your surgery notes show {{S2}}.")).toEqual(S6B("TREATMENT"));
    // Not on the closed list (fail closed): a hyphenated phrase, a plural, another medical phrase.
    expect(shellClinicalLabel("Your medical-team notes", "en-SG")).toBe("CLINICAL_LABEL");
    expect(shellClinicalLabel("Your medical teams", "en-SG")).toBe("CLINICAL_LABEL");
    expect(shellClinicalLabel("Your medical records", "en-SG")).toBe("CLINICAL_LABEL");
    expect(shellClinicalLabel("Surgery at the clinic", "en-SG")).toBe("TREATMENT");
  });
  it("r6: a clinical label next to a neutral phrase is still a hit", () => {
    expect(shellClinicalLabel("The medical team noted diabetes.", "en-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("门诊确诊糖尿病", "zh-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("GP surgery prescribed insulin", "en-SG")).toBe("MEDICATION");
    expect(shellClinicalLabel("Your clinic medication notes", "en-SG")).toBe("MEDICATION");
    expect(shellClinicalLabel("Your doctor dia betes notes", "en-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("医生说明的药物", "zh-SG")).toBe("MEDICATION");
    expect(shellClinicalLabel("体检发现高血压", "zh-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("门诊确诊", "zh-SG")).toBe("DIAGNOSIS");
    expect(careWithIntro(CARE_EN, "The medical team noted diabetes.")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(careWithIntro(CARE_ZH, "门诊确诊糖尿病的记录如下。")).toEqual(S6B("DISEASE_OR_CONDITION"));
    // An earlier gate catches this one first (insulin is an r1 MEASURE_NAME word): the gate observed is S5.
    expect(at("en", "observation", "GP surgery prescribed insulin for {{S2}}.")).toEqual(s5("MEASURE_NAME"));
  });
  it("r6 fix round 1 (coverage suppression): a neutral phrase suppresses only label characters it covers, also in joined copies", () => {
    // A join that adds uncovered characters to a neutral phrase is a hit (clinic + al → clinical); one wholly covered by adjacent
    // neutral phrases is not (医生 + 病历 → 生病 lies inside 医生 and 病历).
    expect(shellClinicalLabel("Your clinic al notes", "en-SG")).toBe("CLINICAL_LABEL");
    expect(shellClinicalLabel("Your clinic ally notes", "en-SG")).toBe("CLINICAL_LABEL");
    expect(shellClinicalLabel("医生、病历都在这里", "zh-SG")).toBeNull();
    expect(shellClinicalLabel("糖、门诊、尿", "zh-SG")).toBeNull();
  });
  it("r6: a label that overlaps a neutral phrase and extends beyond it still hits (labels win on overlap)", () => {
    expect(shellClinicalLabel("确诊所需的记录", "zh-SG")).toBe("DIAGNOSIS");
    expect(shellClinicalLabel("中药房的记录", "zh-SG")).toBe("MEDICATION");
    expect(shellClinicalLabel("西药房", "zh-SG")).toBe("MEDICATION");
    expect(shellClinicalLabel("確診所需", "zh-SG")).toBe("DIAGNOSIS");
    // A label extending to the right of a neutral phrase (门诊 + 诊断) also keeps the phrase unmasked.
    expect(shellClinicalLabel("门诊断", "zh-SG")).toBe("DIAGNOSIS");
    expect(shellClinicalLabel("门诊", "zh-SG")).toBeNull();
  });

  // --- item 4: zh deliberate forms -----------------------------------------------------------------------------------
  it.each(["炎热", "痛快", "政治", "调剂", "生活点滴", "心疼", "不适合", "病历", "看诊", "候诊", "毛病", "药店"])("r6 zh %j is no longer a label and stays VALID", (text) => {
    expect(shellClinicalLabel(`您的${text}记录`, "zh-SG")).toBeNull();
    expect(at("zh", "observation", `您的${text}记录显示为{{S2}}。`)).toMatchObject({ kind: "VALID" });
  });
  it("r6: 不适 is a symptom unless it is followed by 合, 用, 宜 or 应", () => {
    expect(shellClinicalLabel("身体不适", "zh-SG")).toBe("SYMPTOM");
    expect(shellClinicalLabel("有些不适。", "zh-SG")).toBe("SYMPTOM");
    expect(shellClinicalLabel("您的不适记录", "zh-SG")).toBe("SYMPTOM");
    for (const text of ["不适合", "不适用", "不适宜", "不适应", "不適合", "不適應"]) expect(shellClinicalLabel(`这些安排${text}今天`, "zh-SG"), text).toBeNull();
  });
  it("r6: the single characters 诊 病 炎 症 痛 疼 疗 治 晕 咳 肿 呕 剂 疾 药 and the bare 点滴 are no longer labels; 癌 still is", () => {
    for (const character of [..."诊病炎症痛疼疗治晕咳肿呕剂疾药", "点滴"]) expect(shellClinicalLabel(`您的${character}记录`, "zh-SG"), character).toBeNull();
    expect(shellClinicalLabel("您的癌记录", "zh-SG")).toBe("DISEASE_OR_CONDITION");
  });
  it.each([["誤診", "DIAGNOSIS"], ["傳染病", "DISEASE_OR_CONDITION"], ["腎病", "DISEASE_OR_CONDITION"], ["關節炎", "DISEASE_OR_CONDITION"], ["後遺症", "DISEASE_OR_CONDITION"], ["腫脹", "SYMPTOM"], ["紅腫", "SYMPTOM"], ["乾咳", "SYMPTOM"], ["掛點滴", "MEDICATION"], ["療程", "TREATMENT"]] as const)(
    "r6 Traditional form %j is a %s through the T→S copy", (text, category) => {
      expect(shellClinicalLabel(`您的${text}記錄`, "zh-SG")).toBe(category);
    });

  // --- item 5: required true positives (S6b, or the earlier gate that catches it first) ------------------------------
  const EN_TRUE: ReadonlyArray<readonly [string, Category, unknown?]> = [
    ["diabetes", "DISEASE_OR_CONDITION"], ["diabetic", "DISEASE_OR_CONDITION"], ["hypertension", "DISEASE_OR_CONDITION"], ["cancer", "DISEASE_OR_CONDITION"], ["infection", "DISEASE_OR_CONDITION"],
    ["medication", "MEDICATION"], ["medicine", "MEDICATION"], ["diagnosis", "DIAGNOSIS", S6], ["diagnosed", "DIAGNOSIS", S6], ["chemotherapy", "TREATMENT"], ["antihypertensive", "DISEASE_OR_CONDITION"],
    ["undiagnosed", "DIAGNOSIS"], ["insulin", "MEDICATION", s5("MEASURE_NAME")], ["surgery", "TREATMENT"], ["medical", "CLINICAL_LABEL"], ["treatment", "TREATMENT"], ["therapy", "TREATMENT"],
    ["symptoms", "SYMPTOM"], ["pain", "SYMPTOM"], ["heart attack", "DISEASE_OR_CONDITION"], ["high blood pressure", "DISEASE_OR_CONDITION"], ["side effects", "MEDICATION"],
  ];
  it.each(EN_TRUE.map(([word, category, earlier]): [string, Category, unknown] => [word, category, earlier ?? null]))("r6 true positive en %j (%s): rejected at S6b or by the earlier gate observed; case, full-width and typographic variants match", (word, category, earlier) => {
    expect(at("en", "observation", `Your ${word} notes show {{S2}}.`)).toEqual(earlier ?? S6B(category));
    for (const variant of [word.toUpperCase(), `${word[0]!.toUpperCase()}${word.slice(1)}`, Array.from(word, (character) => (character === " " ? " " : String.fromCodePoint(character.codePointAt(0)! + 0xfee0))).join(""), word.replaceAll(" ", " ")]) {
      expect(shellClinicalLabel(`Your ${variant} notes`, "en-SG"), variant).toBe(category);
    }
  });
  const ZH_TRUE: ReadonlyArray<readonly [string, Category, unknown?]> = [
    ["糖尿病", "DISEASE_OR_CONDITION"], ["高血压", "DISEASE_OR_CONDITION"], ["癌症", "DISEASE_OR_CONDITION"], ["感染", "DISEASE_OR_CONDITION"], ["药物", "MEDICATION"], ["用药", "MEDICATION", S6],
    ["诊断", "DIAGNOSIS", S6], ["确诊", "DIAGNOSIS"], ["症状", "SYMPTOM"], ["头痛", "SYMPTOM"], ["发炎", "DISEASE_OR_CONDITION"], ["治疗", "TREATMENT"], ["手术", "TREATMENT"],
    // Traditional.
    ["高血壓", "DISEASE_OR_CONDITION"], ["藥物", "MEDICATION"], ["用藥", "MEDICATION", S6], ["診斷", "DIAGNOSIS", S6], ["症狀", "SYMPTOM"], ["頭痛", "SYMPTOM"], ["治療", "TREATMENT"],
    // Punctuation and space splits (joined copy); 诊·断 uses U+00B7, outside the zh-SG allowlist, so S5 rejects it first.
    ["糖、尿、病", "DISEASE_OR_CONDITION"], ["药／物", "MEDICATION"], ["诊·断", "DIAGNOSIS", s5("DISALLOWED_CHARACTER")], ["高 血 压", "DISEASE_OR_CONDITION"],
  ];
  it.each(ZH_TRUE.map(([text, category, earlier]): [string, Category, unknown] => [text, category, earlier ?? null]))("r6 true positive zh %j (%s): rejected at S6b or by the earlier gate observed", (text, category, earlier) => {
    expect(shellClinicalLabel(`您的${text}记录`, "zh-SG")).toBe(category);
    expect(at("zh", "observation", `您的${text}记录显示为{{S2}}。`)).toEqual(earlier ?? S6B(category));
  });
  it("r6 true positive zh: a slot token between the parts (糖{{S2}}尿病, 药{{S2}}物) is read through the joined copy", () => {
    expect(at("zh", "observation", "您的糖{{S2}}尿病记录。")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(at("zh", "observation", "您的药{{S2}}物记录。")).toEqual(S6B("MEDICATION"));
  });

  // --- the remaining joined-copy cross-punctuation case -----------------------------------------------------------------
  it("documented fail-closed false positive (kept): the joined copy reads 记录中，风雨天 as 中风; limiting joins at clause punctuation would let 糖，尿，病 through", () => {
    expect(shellClinicalLabel("记录中，风雨天的内容", "zh-SG")).toBe("DISEASE_OR_CONDITION");
    expect(at("zh", "observation", "记录中，风雨天的{{S2}}。")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(shellClinicalLabel("您的糖，尿，病记录", "zh-SG")).toBe("DISEASE_OR_CONDITION");
    expect(shellClinicalLabel("您的药。物记录", "zh-SG")).toBe("MEDICATION");
  });
});

describe("shell rules ai-shell-rules.11b.13-r6 fix round 1 (coverage suppression, sibling forms)", () => {
  type Category = "DISEASE_OR_CONDITION" | "DIAGNOSIS" | "SYMPTOM" | "MEDICATION" | "TREATMENT" | "CLINICAL_LABEL";
  const at = (locale: "en" | "zh", text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), observation: text });
  const S6B = (clinicalLabel: Category) => ({ kind: "REJECTED", gate: "S6b", reason: "CLINICAL_MEANING_VIOLATION", repairable: false, clinicalLabel }) as const;
  const S6 = { kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false } as const;
  const careWithIntro = (fixtureId: string, intro: string) => careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro));

  // --- item 1: coverage suppression -------------------------------------------------------------------------------
  it.each([
    ["Your clinic al notes", "CLINICAL_LABEL"], ["Your clinic-al notes", "CLINICAL_LABEL"], ["Your Clinic.al notes", "CLINICAL_LABEL"], ["Your clinic ally notes", "CLINICAL_LABEL"],
    ["Your medical teamdiabetes notes", "CLINICAL_LABEL"], ["Your care team-diabetes notes", "DISEASE_OR_CONDITION"],
  ] as const)("en %j: a label not wholly inside neutral phrases is rejected at S6b", (text, category) => {
    expect(shellClinicalLabel(text, "en-SG")).toBe(category);
    expect(at("en", `${text} show {{S2}}.`)).toEqual(twoSentences(`${text} show {{S2}}.`) ? SENTENCE_BUDGET : S6B(category));
  });
  it.each([
    ["确、诊所需", "DIAGNOSIS"], ["确／诊所需", "DIAGNOSIS"], ["確、診所", "DIAGNOSIS"], ["中、药房", "MEDICATION"], ["西／药房", "MEDICATION"], ["医生、病了", "DISEASE_OR_CONDITION"],
    ["就诊、治", "DIAGNOSIS"], ["确诊所", "DIAGNOSIS"], ["中药房", "MEDICATION"],
  ] as const)("zh %j: a label not wholly inside neutral phrases is rejected at S6b (also across punctuation)", (text, category) => {
    expect(shellClinicalLabel(`您的${text}记录`, "zh-SG")).toBe(category);
    expect(at("zh", `您的${text}记录显示为{{S2}}。`)).toEqual(S6B(category));
  });
  it("zh 门诊断: the label 诊断 extends beyond 门诊 (helper DIAGNOSIS; the legacy S6 rule rejects it first)", () => {
    expect(shellClinicalLabel("您的门诊断记录", "zh-SG")).toBe("DIAGNOSIS");
    expect(at("zh", "您的门诊断记录显示为{{S2}}。")).toEqual(S6);
  });
  it.each([
    ["en-SG", "Your clinic clinic notes"], ["en-SG", "Your doctor doctor notes"], ["en-SG", "Your care team, care team and medical team notes"], ["en-SG", "Your GP surgery and medical appointment notes"],
    ["zh-SG", "医生医生"], ["zh-SG", "门诊门诊复诊"], ["zh-SG", "医生病历"], ["zh-SG", "您的医生病历记录"], ["zh-SG", "医生、病历"], ["zh-SG", "病历"], ["zh-SG", "醫生病歷"],
    ["zh-SG", "您在門診和診所的複診預約如下。"], ["zh-SG", "您给医疗团队和医生看的病历如下。"],
  ] as const)("neutral wording %s %j (alone, repeated, adjacent) carries no clinical label", (locale, text) => {
    expect(shellClinicalLabel(text, locale)).toBeNull();
  });
  it("neutral wording stays VALID through S1–S10 (en and zh, observation and care intros)", () => {
    expect(at("zh", "您的医生病历记录显示为{{S2}}。")).toMatchObject({ kind: "VALID" });
    expect(at("zh", "您的医生、病历记录显示为{{S2}}。")).toMatchObject({ kind: "VALID" });
    expect(at("en", "Your clinic and doctor notes show {{S2}}.")).toMatchObject({ kind: "VALID" });
    expect(careWithIntro(CARE_EN, "Notes for your medical appointment and care team are here.")).toMatchObject({ kind: "VALID" });
    expect(careWithIntro(CARE_ZH, "您给医生看的病历和预约如下。")).toMatchObject({ kind: "VALID" });
  });
  it("a neutral phrase never matches across a slot-token separator: standalone medical / surgery are rejected", () => {
    expect(at("en", "Your medical {{S2}} team notes.")).toEqual(S6B("CLINICAL_LABEL"));
    expect(at("en", "Your GP {{S2}} surgery notes.")).toEqual(S6B("TREATMENT"));
    expect(at("en", "Your medical team notes show {{S2}}.")).toMatchObject({ kind: "VALID" });
    // A label still joins across a token (dia{{S2}}betes, 糖{{S2}}尿病).
    expect(at("en", "Your dia{{S2}}betes notes.")).toEqual(S6B("DISEASE_OR_CONDITION"));
    expect(at("zh", "您的糖{{S2}}尿病记录。")).toEqual(S6B("DISEASE_OR_CONDITION"));
  });

  // --- item 2: sibling forms ----------------------------------------------------------------------------------------
  const ZH_SIBLINGS: ReadonlyArray<readonly [string, Category]> = [
    ...["肚子痛", "胃疼", "牙疼", "腰疼", "背疼", "腿痛", "腿疼", "喉咙痛", "嗓子痛", "心绞痛", "咳血", "便血", "发晕", "头昏"].map((form) => [form, "SYMPTOM"] as const),
    ...["痛风", "鼻炎", "肠炎", "咽炎", "支气管炎", "胃病", "肝病", "肺病", "病人", "重病", "风湿", "湿疹"].map((form) => [form, "DISEASE_OR_CONDITION"] as const),
    ...["药膏", "药水", "开药", "配药"].map((form) => [form, "MEDICATION"] as const),
    ...["治愈", "治好", "诊疗"].map((form) => [form, "TREATMENT"] as const),
  ];
  it.each(ZH_SIBLINGS)("zh sibling form %j is a %s and is rejected at S6b", (form, category) => {
    expect(CLINICAL_LABEL_ENTRIES[category].zh).toContain(form);
    expect(shellClinicalLabel(`您的${form}记录`, "zh-SG")).toBe(category);
    expect(at("zh", `您的${form}记录显示为{{S2}}。`)).toEqual(S6B(category));
  });
  const EN_SIBLINGS: ReadonlyArray<readonly [string, Category]> = [
    ["antidiabetic", "DISEASE_OR_CONDITION"], ["antidiabetics", "DISEASE_OR_CONDITION"], ["infective", "DISEASE_OR_CONDITION"],
    ["unmedicated", "MEDICATION"], ["overmedicated", "MEDICATION"], ["medicates", "MEDICATION"],
    ["immunotherapy", "TREATMENT"], ["immunotherapies", "TREATMENT"], ["chemotherapies", "TREATMENT"], ["radiotherapies", "TREATMENT"], ["therapeutics", "TREATMENT"], ["therapeutic", "TREATMENT"],
  ];
  it.each(EN_SIBLINGS)("en sibling form %j is a %s and is rejected at S6b", (word, category) => {
    expect(CLINICAL_LABEL_ENTRIES[category].en).toContain(word);
    expect(shellClinicalLabel(`Your ${word.toUpperCase()} notes`, "en-SG")).toBe(category);
    expect(at("en", `Your ${word} notes show {{S2}}.`)).toEqual(S6B(category));
  });
  it("no single-character pain form is added (很痛, 有点疼 pass); therapist forms stay listed", () => {
    for (const text of ["很痛", "有点疼", "心疼", "痛快"]) expect(shellClinicalLabel(`今天${text}的记录`, "zh-SG"), text).toBeNull();
    expect(CLINICAL_LABEL_ENTRIES.TREATMENT.en).toEqual(expect.arrayContaining(["therapist", "therapists", "physiotherapist", "psychotherapist", "hydrotherapist"]));
  });
  it.each([["喉嚨痛", "SYMPTOM"], ["心絞痛", "SYMPTOM"], ["腸炎", "DISEASE_OR_CONDITION"], ["風濕", "DISEASE_OR_CONDITION"], ["濕疹", "DISEASE_OR_CONDITION"], ["溼疹", "DISEASE_OR_CONDITION"], ["治癒", "TREATMENT"], ["診療", "TREATMENT"], ["開藥", "MEDICATION"]] as const)(
    "Traditional sibling %j is a %s through the T→S copy", (text, category) => {
      expect(shellClinicalLabel(`您的${text}記錄`, "zh-SG")).toBe(category);
    });
  it("the fix-round T→S rows are pinned", () => {
    for (const [traditional, simplified] of [["嚨", "咙"], ["絞", "绞"], ["腸", "肠"], ["濕", "湿"], ["溼", "湿"], ["癒", "愈"], ["歷", "历"], ["曆", "历"]]) expect(TRADITIONAL_TO_SIMPLIFIED.get(traditional), traditional).toBe(simplified);
  });
});

describe("shell rules ai-shell-rules.11b.13-r6 fix round 2 (sibling symptoms, token separator literal)", () => {
  type Category = "DISEASE_OR_CONDITION" | "DIAGNOSIS" | "SYMPTOM" | "MEDICATION" | "TREATMENT" | "CLINICAL_LABEL";
  const at = (locale: "en" | "zh", text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), observation: text });
  const S6B = (clinicalLabel: Category) => ({ kind: "REJECTED", gate: "S6b", reason: "CLINICAL_MEANING_VIOLATION", repairable: false, clinicalLabel }) as const;

  it.each(["嗓子疼", "脚痛", "脚疼", "膝盖痛", "膝盖疼"])("zh SYMPTOM %j is listed and rejected at S6b", (form) => {
    expect(CLINICAL_LABEL_ENTRIES.SYMPTOM.zh).toContain(form);
    expect(shellClinicalLabel(`您的${form}记录`, "zh-SG")).toBe("SYMPTOM");
    expect(at("zh", `您的${form}记录显示为{{S2}}。`)).toEqual(S6B("SYMPTOM"));
  });
  it.each(["腳痛", "腳疼", "膝蓋痛", "膝蓋疼"])("Traditional %j is a SYMPTOM through the T→S copy", (form) => {
    expect(shellClinicalLabel(`您的${form}記錄`, "zh-SG")).toBe("SYMPTOM");
  });
  it("the fix-round-2 T→S rows are pinned", () => {
    expect(TRADITIONAL_TO_SIMPLIFIED.get("腳")).toBe("脚");
    expect(TRADITIONAL_TO_SIMPLIFIED.get("蓋")).toBe("盖");
  });
  it.each(["coughed", "coughing", "ached", "aching", "bled", "wheeze", "wheezed", "cramping", "cramped"])("en SYMPTOM inflection %j is listed and rejected at S6b", (word) => {
    expect(CLINICAL_LABEL_ENTRIES.SYMPTOM.en).toContain(word);
    expect(shellClinicalLabel(`Your ${word.toUpperCase()} notes`, "en-SG")).toBe("SYMPTOM");
    expect(at("en", `Your ${word} notes show {{S2}}.`)).toEqual(S6B("SYMPTOM"));
  });
  it("the must-pass set and every neutral phrase still carry no clinical label", () => {
    for (const text of ["病历", "看诊", "候诊", "毛病", "药店", "炎热", "痛快", "政治", "调剂", "生活点滴", "心疼", "不适合", ...CLINICAL_NEUTRAL_PHRASES.zh]) expect(shellClinicalLabel(`您的${text}记录`, "zh-SG"), text).toBeNull();
    for (const phrase of CLINICAL_NEUTRAL_PHRASES.en) expect(shellClinicalLabel(`Your ${phrase} notes`, "en-SG"), phrase).toBeNull();
  });
  it("CLINICAL_TOKEN_SEPARATOR is U+E001, written as an escape (no raw private-use character in the lexicon source)", () => {
    expect(CLINICAL_TOKEN_SEPARATOR).toBe("\uE001");
    const source = readFileSync(`${process.cwd()}/src/application/ai/language/shell-lexicon.ts`, "utf8");
    expect(source).not.toMatch(/[\uE000-\uF8FF]/u);
    expect(source).toContain('CLINICAL_TOKEN_SEPARATOR = "\\uE001"');
  });
});

/**
 * Rules r7 (owner instruction 2026-10-06, Packet 11B.14, offline only): bare "up" and "down" leave the r1 COMPARATIVE_DIRECTION
 * alternation (every other alternative and every zh form unchanged); a contextual en rule under the same code rejects genuine
 * direction constructions — a listed movement/state verb followed by up/down, and up/down followed by from/to/by unless up/down is
 * the particle of a closed list of note-taking/raising phrasal verbs — on the same scan copies as the r1 rule.
 */
describe("shell rules ai-shell-rules.11b.14-r7 (contextual English up/down)", () => {
  type Field = "headline" | "observation" | "evidence";
  const at = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  const s5 = (violation: string) => ({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: expect.arrayContaining([violation]) });
  const DIRECTION = s5("COMPARATIVE_DIRECTION");
  const direction = (text: string, locale: "en-SG" | "zh-SG" = "en-SG") => shellLexicalViolations(text, locale).includes("COMPARATIVE_DIRECTION");
  const careWithIntro = (fixtureId: string, intro: string) => careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro));
  /** A full candidate (the fixture's default shells with `edit` applied) through S1–S7b, the assembler (S9) and the composition verifier (S10). */
  const fullCandidate = (fixtureId: string, edit: (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => void) => {
    const fixture = PACKET_11_HYBRID_FIXTURES.find((item) => item.id === fixtureId)!;
    const bundleOf = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
    const planned = planSlots(fixture.request, bundleOf);
    if (planned.kind !== "PLANNED") throw new Error(fixtureId);
    const texts = new Map(defaultShells(planned.plan));
    edit(planned.plan, texts);
    const result = validateShellCandidate(planned.plan, bundleOf, shellCandidate(planned.plan, texts));
    if (result.kind !== "VALID") return result;
    const assembled = assembleAi(fixture.request, planned.plan, planned.atoms, result.shells, bundleOf);
    if (assembled.kind !== "ASSEMBLED") return assembled;
    return verifyComposition(fixture.request, bundleOf, assembled.composition);
  };
  const EXPLAIN_EN = "p11.explain-pattern.en-sg.ordinary";
  const intro = (text: string) => (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => texts.set(plan.sections[0]!.introPath, text);
  // Observation ownership: a former observation edit is replayed as the model-written evidence (asModelFields; ordinary fixture).
  const observation = (text: string) => (_plan: SlotPlan, texts: Map<ShellFieldPath, string>) => texts.set("evidence", asModelFields({ observation: text }).evidence!);
  /** The brief's movement/state verbs (closed list). */
  const VERBS = ["went", "go", "goes", "going", "gone", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "moved", "moves", "moving", "came", "come", "comes", "coming", "trended", "trending", "headed", "heading", "ticked", "edged", "shot", "spiked", "stayed", "stays", "remained", "remains", "crept", "creeping"] as const;
  /** The brief's closed list of non-measurement phrasal verbs whose particle up/down may precede from/to/by. */
  const PHRASAL = ["note", "notes", "noted", "noting", "write", "writes", "wrote", "written", "writing", "jot", "jots", "jotted", "jotting", "take", "takes", "took", "taken", "taking", "bring", "brings", "brought", "bringing", "put", "puts", "putting"] as const;

  // --- revision and the r1 entry ------------------------------------------------------------------------------------
  it("pins rules r7 and the unchanged gate order", () => {
    expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12");
    expect(SHELL_GATE_ORDER).toEqual(["S1", "S2", "S2a", "S3", "S4", "S4b", "S5", "S6", "S6b", "S7", "S7b"]);
  });
  it("the r1 COMPARATIVE_DIRECTION entry lists every earlier alternative except bare up and down; the zh forms are unchanged", () => {
    const entries = SHELL_LEXICAL_RULES.filter(([violation]) => violation === "COMPARATIVE_DIRECTION");
    expect(entries).toHaveLength(1);
    const [, pattern] = entries[0]!;
    expect(pattern.flags).toBe("i");
    expect(pattern.source).toBe(String.raw`\b(?:rose|rises?|risen|rising|fell|falls?|fallen|falling|increas\w*|decreas\w*|higher|lower|more|less|improv\w*|worse\w*|better|drop\w*|climb\w*|jump\w*|declin\w*|grew|grow\w*)\b|上升|下降|升高|降低|增加|减少|更高|更低|变好|变差|好转|恶化|上涨|下跌|提高|回落`);
    expect(Object.isFrozen(pattern)).toBe(true);
    for (const bare of ["up", "down", "Up", "DOWN"]) expect(pattern.test(bare), bare).toBe(false);
  });

  // --- must reject ----------------------------------------------------------------------------------------------------
  it.each(["went down", "is down", "was down", "down from", "down to", "went up", "is up", "was up", "up from", "up to", "noted it went down", "Your readings went down.", "values down to", "down by", "up by", "It's down", "they're up", "it is up"])(
    "lexicon: %j is COMPARATIVE_DIRECTION",
    (text) => {
      expect(direction(text)).toBe(true);
    },
  );
  // Fix round 1 (controller ruling): come/came/comes/coming + up is accepted ("Questions that came up"); come-forms + down still reject.
  it.each(VERBS)("lexicon: every listed verb %j followed by up or down is COMPARATIVE_DIRECTION (any case, any whitespace or hyphen; come-forms: down only)", (verb) => {
    const particles = ["came", "come", "comes", "coming"].includes(verb) ? ["down"] : ["up", "down"];
    for (const particle of particles) {
      expect(direction(`Your notes ${verb} ${particle}`), `${verb} ${particle}`).toBe(true);
      expect(direction(`YOUR NOTES ${verb.toUpperCase()}  ${particle.toUpperCase()}`), `${verb} ${particle} upper`).toBe(true);
      expect(direction(`Your notes ${verb}-${particle}`), `${verb}-${particle}`).toBe(true);
      expect(direction(`Your notes ${verb}\n${particle} here`), `${verb}\\n${particle}`).toBe(true);
    }
  });
  it("full candidates that reach S5 are rejected there with COMPARATIVE_DIRECTION", () => {
    expect(careWithIntro(CARE_EN, "Your readings went down.")).toEqual(DIRECTION);
    expect(careWithIntro(CARE_EN, "Your readings were up from before.")).toEqual(DIRECTION);
    expect(at("en", "observation", "It was up from {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your values down to {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your values up to {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your readings went down: {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your readings is down at {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your readings went up: {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your notes noted it went down: {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "headline", "Readings down from {{S1}}.")).toEqual(DIRECTION);
    expect(at("en", "evidence", "Values up from {{S3}}.")).toEqual(DIRECTION);
    // The S5 rejection is the same violation code as the r1 words; the result carries it once.
    const result = at("en", "observation", "Your readings went down and rose: {{S2}}.") as { lexical?: string[] };
    expect(result.lexical!.filter((violation) => violation === "COMPARATIVE_DIRECTION")).toHaveLength(1);
  });
  it("every previous en COMPARATIVE_DIRECTION control is still rejected at S5", () => {
    for (const word of ["rose", "rises", "risen", "rising", "fell", "falls", "fallen", "falling", "increased", "increasing", "decreased", "decreasing", "higher", "lower", "more", "less", "improved", "improving", "worse", "worsened", "better", "dropped", "climbed", "jumped", "declined", "grew", "growing"]) {
      expect(at("en", "observation", `Values ${word}: {{S2}}.`), word).toEqual(DIRECTION);
    }
  });
  it("every previous zh COMPARATIVE_DIRECTION control is still rejected at S5 (Simplified and Traditional)", () => {
    for (const form of ["上升", "下降", "升高", "降低", "增加", "减少", "更高", "更低", "变好", "变差", "好转", "恶化", "上涨", "下跌", "提高", "回落"]) {
      expect(at("zh", "observation", `数值${form}：{{S2}}。`), form).toEqual(DIRECTION);
    }
    for (const form of ["上漲", "減少", "變差", "惡化", "變好", "好轉"]) expect(at("zh", "observation", `數值${form}：{{S2}}。`), form).toEqual(DIRECTION);
  });
  it("the contextual rule reads the same scan copies as the r1 rule: folded (case, dashes, NBSP, full-width, underscore) and look-alike", () => {
    for (const text of ["It WENT DOWN at", "It went down at", "It went_down at", "It went—down at", "It ｗｅｎｔ ｄｏｗｎ at", "It went dovvn at", "It vvent down at", "It Is up at", "It IS UP at", "Values dovvn to", "values‑down‑to"]) {
      expect(direction(text), text).toBe(true);
    }
    expect(at("en", "observation", "It went dovvn at {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "It went down at {{S2}}.")).toEqual(DIRECTION);
    // Latin words inside zh-SG wording are read too (as the r1 words are).
    expect(direction("您的记录went down", "zh-SG")).toBe(true);
    expect(direction("您的记录 up to", "zh-SG")).toBe(true);
  });

  // --- must accept ----------------------------------------------------------------------------------------------------
  it.each(["noted down to share", "Things you noted down to share.", "bring up for discussion", "Topics to bring up for discussion.", "You wrote these down to bring along.", "jotted down"])(
    "lexicon: %j is not COMPARATIVE_DIRECTION",
    (text) => {
      expect(shellLexicalViolations(text, "en-SG")).toEqual([]);
    },
  );
  it("the must-accept phrases are accepted as full candidates through S1–S10 (care intros and EXPLAIN observations)", () => {
    for (const text of ["Things you noted down to share.", "Topics to bring up for discussion.", "You wrote these down to bring along.", "Items you jotted down for the visit.", "Notes you noted down to share are here."]) {
      expect(fullCandidate(CARE_EN, intro(text)), text).toMatchObject({ kind: "ACCEPTED" });
    }
    for (const text of ["Items noted down to share: {{S2}}.", "Items to bring up for discussion: {{S2}}.", "Items you jotted down: {{S2}}.", "You wrote these down to bring along: {{S2}}."]) {
      expect(fullCandidate(EXPLAIN_EN, observation(text)), text).toMatchObject({ kind: "ACCEPTED" });
    }
  });
  it("bare up or down outside a listed construction is no longer a direction word", () => {
    for (const text of ["Your notes, up and down the page", "Look up the list", "Items you put down", "Notes to take up", "Written up here", "A write-up of the notes", "flare-up"]) {
      expect(direction(text), text).toBe(false);
    }
    // "flare-up" now reaches S6b (its clinical label) instead of S5: still rejected.
    expect(at("en", "observation", "Your flare-up notes show {{S2}}.")).toEqual({ kind: "REJECTED", gate: "S6b", reason: "CLINICAL_MEANING_VIOLATION", repairable: false, clinicalLabel: "DISEASE_OR_CONDITION" });
  });

  // --- the phrasal exception is closed ---------------------------------------------------------------------------------
  it.each(PHRASAL)("the phrasal verb %j exempts its own particle before from/to/by (directly, or after one object pronoun)", (verb) => {
    for (const particle of ["up", "down"]) {
      for (const preposition of ["from", "to", "by"]) {
        expect(direction(`Items ${verb} ${particle} ${preposition} share`), `${verb} ${particle} ${preposition}`).toBe(false);
        expect(direction(`ITEMS ${verb.toUpperCase()} ${particle.toUpperCase()} ${preposition.toUpperCase()} SHARE`), `${verb} ${particle} ${preposition} upper`).toBe(false);
      }
      for (const pronoun of ["it", "them", "these", "those", "this", "that"]) expect(direction(`Items ${verb} ${pronoun} ${particle} to share`), `${verb} ${pronoun} ${particle}`).toBe(false);
    }
  });
  it("the exception is closed: any other word before up/down + from/to/by still rejects", () => {
    for (const word of ["values", "readings", "levels", "scrolled", "turned", "settled", "slowed", "cut", "brung", "noting's", "notebook", "input", "retake", "footnote", "rewrote", "notes,", "noted.", "noted:"]) {
      for (const particle of ["up", "down"]) expect(direction(`Items ${word} ${particle} to share`), `${word} ${particle}`).toBe(true);
    }
    // Any case: the from/to/by construction is read case-insensitively, like every other en rule.
    for (const text of ["VALUES DOWN TO", "Values Up From", "values DOWN by"]) expect(direction(text), text).toBe(true);
    // Only a listed object pronoun may sit between the verb and its particle; any other word (or two words) rejects.
    for (const object of ["values", "the values", "it all", "readings"]) expect(direction(`You wrote ${object} down to share`), object).toBe(true);
    expect(direction("You noted it, down to share")).toBe(true);
  });
  it("the exception never suppresses the verb rule", () => {
    for (const text of ["noted it went down", "You wrote these down and they went up", "Notes you took when it was down", "Brought up when readings were down", "noted down to share; it went down"]) {
      expect(direction(text), text).toBe(true);
    }
  });
});

/**
 * Rules r7 fix round 1 (controller rulings, still ai-shell-rules.11b.14-r7): come-forms + up accepted (+ down still rejects);
 * "up to date" / "up-to-date" accepted; the contextual rule also reads the en split-rejoined copies (r3 join limits); one optional
 * closed-list adverb between the verb and up/down; negated be/have forms count as verbs; passive phrasal wording is accepted.
 */
describe("shell rules ai-shell-rules.11b.14-r7 fix round 1 (come up, up to date, splits, adverbs, negations)", () => {
  type Field = "headline" | "observation" | "evidence";
  const EXPLAIN_EN_ID = "p11.explain-pattern.en-sg.ordinary";
  const at = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  const DIRECTION = { kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: expect.arrayContaining(["COMPARATIVE_DIRECTION"]) };
  const direction = (text: string, locale: "en-SG" | "zh-SG" = "en-SG") => shellLexicalViolations(text, locale).includes("COMPARATIVE_DIRECTION");
  const careWithIntro = (fixtureId: string, intro: string) => careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro));
  const fullCandidate = (fixtureId: string, edit: (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => void) => {
    const fixture = PACKET_11_HYBRID_FIXTURES.find((item) => item.id === fixtureId)!;
    const bundleOf = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
    const planned = planSlots(fixture.request, bundleOf);
    if (planned.kind !== "PLANNED") throw new Error(fixtureId);
    const texts = new Map(defaultShells(planned.plan));
    edit(planned.plan, texts);
    const result = validateShellCandidate(planned.plan, bundleOf, shellCandidate(planned.plan, texts));
    if (result.kind !== "VALID") return result;
    const assembled = assembleAi(fixture.request, planned.plan, planned.atoms, result.shells, bundleOf);
    if (assembled.kind !== "ASSEMBLED") return assembled;
    return verifyComposition(fixture.request, bundleOf, assembled.composition);
  };
  const intro = (text: string) => (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => texts.set(plan.sections[0]!.introPath, text);
  // Observation ownership: a former observation edit is replayed as the model-written evidence (asModelFields; ordinary fixture).
  const observation = (text: string) => (_plan: SlotPlan, texts: Map<ShellFieldPath, string>) => texts.set("evidence", asModelFields({ observation: text }).evidence!);
  const ADVERBS = ["slightly", "now", "still", "also", "further", "back", "right", "way", "all", "even", "much"] as const;
  const NEGATED = ["isn't", "wasn't", "aren't", "weren't", "hasn't", "haven't", "hadn't"] as const;
  /** The split-free accepted phrases of r7 and this round; each must stay accepted. */
  const ACCEPTED = ["noted down to share", "Things you noted down to share.", "bring up for discussion", "Topics to bring up for discussion.", "You wrote these down to bring along.", "jotted down", "Questions that came up", "Topics that came up", "Your notes are up to date.", "An up-to-date list", "Your notes are UP-TO-DATE", "is noted down", "were written down to share", "Notes that were noted down to share"];

  // --- item 1: come + up ----------------------------------------------------------------------------------------------
  it("come/came/comes/coming + up is accepted; + down and up/down + from/to/by still reject", () => {
    for (const verb of ["come", "came", "comes", "coming"]) {
      expect(direction(`Questions that ${verb} up`), `${verb} up`).toBe(false);
      expect(direction(`Questions that ${verb.toUpperCase()} UP`), `${verb} UP`).toBe(false);
      expect(direction(`Your readings ${verb} down`), `${verb} down`).toBe(true);
      expect(direction(`Your readings ${verb} up to`), `${verb} up to`).toBe(true);
      expect(direction(`Your readings ${verb} up from`), `${verb} up from`).toBe(true);
    }
    expect(direction("Topics that came up today")).toBe(false);
    expect(shellLexicalViolations("Topics that came up today", "en-SG")).toEqual(["DATE_OR_TIME"]);
    expect(fullCandidate(CARE_EN, intro("Questions that came up."))).toMatchObject({ kind: "ACCEPTED" });
    expect(fullCandidate(CARE_EN, intro("Topics that came up are listed here."))).toMatchObject({ kind: "ACCEPTED" });
    expect(careWithIntro(CARE_EN, "Your readings came down.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your readings came up to {{S2}}.")).toEqual(DIRECTION);
  });

  // --- item 2: up to date --------------------------------------------------------------------------------------------
  it("\"up to date\" and \"up-to-date\" (any case) are accepted; up to anything else still rejects", () => {
    for (const text of ["Your notes are up to date.", "Your notes are up-to-date.", "An up-to-date list", "UP TO DATE", "Up-To-Date notes", "Your notes are still up to date", "It's up to date"]) {
      expect(direction(text), text).toBe(false);
    }
    expect(fullCandidate(CARE_EN, intro("Your notes are up to date."))).toMatchObject({ kind: "ACCEPTED" });
    expect(fullCandidate(EXPLAIN_EN_ID, observation("Your up-to-date records show {{S2}}."))).toMatchObject({ kind: "ACCEPTED" });
    for (const text of ["up to", "values up to", "is up to", "up to dates", "up to day", "down to date", "up to the date"]) expect(direction(text), text).toBe(true);
    expect(at("en", "observation", "Values up to {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "Your notes are up to {{S2}}.")).toEqual(DIRECTION);
  });

  // --- item 3: splits ------------------------------------------------------------------------------------------------
  it("split forms (single separator, 2–3 pieces, as the r3 join) are rejected", () => {
    for (const text of ["went d own", "we nt down", "is u p", "d own to", "values do wn to", "went d.own", "went do-wn", "w e nt down", "was d ow n", "it came d own", "up fr om", "dow n by"]) {
      expect(direction(text), text).toBe(true);
    }
    expect(at("en", "observation", "Values d own to {{S2}}.")).toEqual(DIRECTION);
    expect(at("en", "observation", "It is u p at {{S2}}.")).toEqual(DIRECTION);
    expect(careWithIntro(CARE_EN, "Your readings we nt down.")).toEqual(DIRECTION);
    expect(careWithIntro(CARE_EN, "Your readings went d own.")).toEqual(DIRECTION);
  });
  it("the split copy keeps the r3 limits: two separators or a four-piece split is not rejoined", () => {
    expect(direction("went d  own")).toBe(false);
    expect(direction("went d o w n")).toBe(false);
  });
  it("split-free accepted phrases stay accepted (a join elsewhere in the text never rejects them); zh-SG gets no en split copy, as in r3", () => {
    for (const text of ACCEPTED) expect(shellLexicalViolations(text, "en-SG"), text).toEqual([]);
    expect(direction("您的记录 we nt down", "zh-SG")).toBe(false);
    expect(direction("您的记录 went down", "zh-SG")).toBe(true);
  });

  // --- item 4: adverbs, negations, passive phrasal ---------------------------------------------------------------------
  it.each(ADVERBS)("one closed-list adverb %j between the verb and up/down still rejects", (adverb) => {
    for (const particle of ["up", "down"]) expect(direction(`Your readings went ${adverb} ${particle}`), `${adverb} ${particle}`).toBe(true);
    expect(direction(`Your readings came ${adverb} down`), `came ${adverb} down`).toBe(true);
    expect(direction(`Questions that came ${adverb} up`), `came ${adverb} up`).toBe(false);
  });
  it("the adverb slot is closed and single", () => {
    for (const text of ["went slightly down", "is now up", "went back down", "is still up", "WENT SLIGHTLY DOWN", "went-back-down"]) expect(direction(text), text).toBe(true);
    for (const text of ["went quickly down", "is very up", "went slightly back down", "is noted down", "were written down", "is jotted down", "has written up"]) expect(direction(text), text).toBe(false);
    expect(at("en", "observation", "Your readings went slightly down: {{S2}}.")).toEqual(DIRECTION);
    expect(careWithIntro(CARE_EN, "Your readings went back down.")).toEqual(DIRECTION);
  });
  it.each(NEGATED)("the negated form %j counts as a verb (straight and typographic apostrophes)", (verb) => {
    for (const particle of ["up", "down"]) {
      expect(direction(`It ${verb} ${particle}`), `${verb} ${particle}`).toBe(true);
      expect(direction(`It ${verb.replace("'", "’")} ${particle}`), `${verb} typographic ${particle}`).toBe(true);
      expect(direction(`It ${verb.toUpperCase()} still ${particle}`), `${verb} still ${particle}`).toBe(true);
    }
  });
  it("negated verbs reach S5 in full candidates", () => {
    expect(careWithIntro(CARE_EN, "Your readings isn't down.")).toEqual(DIRECTION);
    expect(careWithIntro(CARE_EN, "Your readings wasn’t up.")).toEqual(DIRECTION);
  });
  it("the phrasal exemption still wins and passive phrasal wording is accepted, as full candidates too", () => {
    for (const text of ["is noted down", "were written down to share", "Notes that were noted down to share", "Things that are jotted down", "Items that were brought up from your notes"]) {
      expect(direction(text), text).toBe(false);
    }
    expect(fullCandidate(CARE_EN, intro("Things that were written down to share."))).toMatchObject({ kind: "ACCEPTED" });
    expect(fullCandidate(CARE_EN, intro("Notes that are noted down for the visit."))).toMatchObject({ kind: "ACCEPTED" });
    expect(fullCandidate(EXPLAIN_EN_ID, observation("Items noted down to share: {{S2}}."))).toMatchObject({ kind: "ACCEPTED" });
  });
});

/**
 * Rules r7 fix round 2 (controller rulings, still ai-shell-rules.11b.14-r7): every inflection of the listed contextual verbs; one
 * closed-list modifier between up/down and from/to/by; the phrasal exemption never applies when from/to/by is followed by a slot
 * token or a digit (S5 passes the token-bearing field text to the lexicon for this guard only); hoisted global matchers.
 */
describe("shell rules ai-shell-rules.11b.14-r7 fix round 2 (inflections, modifier slot, token/digit guard)", () => {
  type Field = "headline" | "observation" | "evidence";
  const EXPLAIN_EN_ID = "p11.explain-pattern.en-sg.ordinary";
  const at = (locale: "en" | "zh", field: Field, text: string) => check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), [field]: text });
  const DIRECTION = { kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: expect.arrayContaining(["COMPARATIVE_DIRECTION"]) };
  const direction = (text: string, tokenText?: string) => shellLexicalViolations(text, "en-SG", tokenText).includes("COMPARATIVE_DIRECTION");
  /** As S5 reads a field: tokens removed for every rule, the token-bearing text for the r7 guard. */
  const s5Direction = (text: string) => direction(stripSlotTokens(text, " "), text);
  const careWithIntro = (fixtureId: string, intro: string) => careCheck(fixtureId, (plan, texts) => texts.set(plan.sections[0]!.introPath, intro));
  const fullCandidate = (fixtureId: string, edit: (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => void) => {
    const fixture = PACKET_11_HYBRID_FIXTURES.find((item) => item.id === fixtureId)!;
    const bundleOf = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
    const planned = planSlots(fixture.request, bundleOf);
    if (planned.kind !== "PLANNED") throw new Error(fixtureId);
    const texts = new Map(defaultShells(planned.plan));
    edit(planned.plan, texts);
    const result = validateShellCandidate(planned.plan, bundleOf, shellCandidate(planned.plan, texts));
    if (result.kind !== "VALID") return result;
    const assembled = assembleAi(fixture.request, planned.plan, planned.atoms, result.shells, bundleOf);
    if (assembled.kind !== "ASSEMBLED") return assembled;
    return verifyComposition(fixture.request, bundleOf, assembled.composition);
  };
  const intro = (text: string) => (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => texts.set(plan.sections[0]!.introPath, text);
  // Observation ownership: a former observation edit is replayed as the model-written evidence (asModelFields; ordinary fixture).
  const observation = (text: string) => (_plan: SlotPlan, texts: Map<ShellFieldPath, string>) => texts.set("evidence", asModelFields({ observation: text }).evidence!);
  /** Every inflection of every listed verb (be and have included); the come-forms keep the come + up acceptance. */
  const INFLECTIONS = [
    "go", "goes", "going", "went", "gone", "am", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "having",
    "move", "moves", "moved", "moving", "trend", "trends", "trended", "trending", "head", "heads", "headed", "heading",
    "tick", "ticks", "ticked", "ticking", "edge", "edges", "edged", "edging", "shoot", "shoots", "shot", "shooting",
    "spike", "spikes", "spiked", "spiking", "stay", "stays", "stayed", "staying", "remain", "remains", "remained", "remaining",
    "creep", "creeps", "crept", "creeping",
  ] as const;
  const MODIFIERS = ["slightly", "sharply", "somewhat", "further", "back", "again", "steadily", "gradually", "a little", "a bit"] as const;

  // --- item 1: inflections -------------------------------------------------------------------------------------------
  it.each(INFLECTIONS)("every inflection %j followed by up or down (directly or after one listed adverb) is COMPARATIVE_DIRECTION", (verb) => {
    for (const particle of ["up", "down"]) {
      expect(direction(`Your readings ${verb} ${particle}`), `${verb} ${particle}`).toBe(true);
      expect(direction(`YOUR READINGS ${verb.toUpperCase()} STILL ${particle.toUpperCase()}`), `${verb} still ${particle}`).toBe(true);
    }
  });
  it("the come-forms keep the come + up acceptance; come + down still rejects", () => {
    for (const verb of ["come", "comes", "came", "coming"]) {
      expect(direction(`Questions that ${verb} up`), verb).toBe(false);
      expect(direction(`Readings that ${verb} down`), verb).toBe(true);
    }
  });
  it("the listed inflection sentences are rejected at S5 as full candidates", () => {
    for (const text of ["Your readings remain up.", "Your readings stay down.", "Your readings trend down.", "Values move up.", "Readings head down.", "Values tick up.", "Readings creep up."]) {
      expect(careWithIntro(CARE_EN, text), text).toEqual(DIRECTION);
    }
    expect(at("en", "observation", "Your readings remain up at {{S2}}.")).toEqual(DIRECTION);
  });
  it("\"up to date\" stays accepted after the new inflections", () => {
    for (const text of ["Notes that remain up to date", "Staying up to date", "Your notes stay up-to-date"]) expect(direction(text), text).toBe(false);
  });

  // --- item 2: modifier slot before from/to/by -----------------------------------------------------------------------
  it.each(MODIFIERS)("up/down + the modifier %j + from/to/by is COMPARATIVE_DIRECTION", (modifier) => {
    for (const particle of ["up", "down"]) {
      for (const preposition of ["from", "to", "by"]) {
        expect(direction(`Readings ${particle} ${modifier} ${preposition}`), `${particle} ${modifier} ${preposition}`).toBe(true);
        expect(direction(`READINGS ${particle.toUpperCase()} ${modifier.toUpperCase()} ${preposition.toUpperCase()}`), `${particle} ${modifier} ${preposition} upper`).toBe(true);
      }
    }
  });
  it("the listed modifier sentences are rejected at S5 as full candidates", () => {
    for (const text of ["Readings up slightly from {{S2}}.", "Readings down sharply from {{S2}}.", "Readings up a little from {{S2}}.", "Values down again to {{S2}}."]) {
      expect(at("en", "observation", text), text).toEqual(DIRECTION);
    }
  });
  it("the modifier slot is closed and single, and the phrasal exemption still applies before it", () => {
    for (const text of ["Readings up quickly from", "Readings up slightly again from", "Readings down slightly again to", "Readings down a bit further from", "Readings down a lot to", "Items noted down again to share", "Topics to bring up again for discussion"]) {
      expect(direction(text), text).toBe(false);
    }
  });

  // --- item 3: token/digit guard on the phrasal exemption -------------------------------------------------------------
  it("the phrasal exemption never applies before a slot token or a digit", () => {
    for (const text of ["Your readings were brought down to {{S2}}.", "Values were taken down to {{S2}}.", "Values put down to {{S2}}.", "Values were brought up to {{S2}}.", "Values noted down to {{S2}}.", "Values brought down again to {{S2}}.", "Values put down to{{S2}}.", "Values put d own to {{S2}}."]) {
      expect(s5Direction(text), text).toBe(true);
      expect(at("en", "observation", text), text).toEqual(DIRECTION);
    }
    for (const text of ["Values put down to 5", "Values noted down to 7 items", "Values brought up from 3"]) expect(direction(text), text).toBe(true);
    expect(shellLexicalViolations("Values put down to 5", "en-SG")).toEqual(expect.arrayContaining(["DIGIT", "COMPARATIVE_DIRECTION"]));
  });
  it("the guard reads only a token or digit right after from/to/by: the accepted phrases stay accepted, with and without tokens elsewhere", () => {
    for (const text of ["Things you noted down to share.", "Topics to bring up for discussion.", "You wrote these down to bring along.", "Items noted down to share: {{S2}}.", "Items you jotted down: {{S2}}.", "Notes to bring up from {{S2}} are below."]) {
      expect(s5Direction(text), text).toBe(text === "Notes to bring up from {{S2}} are below.");
    }
    for (const text of ["Things you noted down to share.", "Topics to bring up for discussion.", "You wrote these down to bring along."]) {
      expect(fullCandidate(CARE_EN, intro(text)), text).toMatchObject({ kind: "ACCEPTED" });
    }
    expect(fullCandidate(EXPLAIN_EN_ID, observation("Items noted down to share: {{S2}}."))).toMatchObject({ kind: "ACCEPTED" });
    // Without the token-bearing text (other callers), the guard still reads digits; tokens are then invisible.
    expect(direction(stripSlotTokens("Values put down to {{S2}}.", " "))).toBe(false);
  });

  // --- item 4: performance -----------------------------------------------------------------------------------------
  it("the r7 global matchers are hoisted (no RegExp built per scan copy) and behaviour is unchanged", () => {
    const source = readFileSync(`${process.cwd()}/src/application/ai/language/shell-lexicon.ts`, "utf8");
    const r7 = source.slice(source.indexOf("const R7_DIRECTION_VERBS"), source.indexOf("Rules r3 entries (owner list revision"));
    expect(r7).not.toMatch(/new RegExp\(context\.source/);
    expect(r7).toMatch(/R7_DIRECTION_GLOBAL/);
    for (let round = 0; round < 3; round += 1) {
      expect(direction("we nt down"), `round ${round}`).toBe(true);
      expect(direction("Things you noted down to share."), `round ${round}`).toBe(false);
    }
  });
});

/**
 * Rules r8 (owner instruction 2026-10-07, Packet 11B.15, ai-shell-rules.11b.15-r8): S6 placeholder provenance. Every observed zh-SG
 * EXPLAIN S6 fallback of the stored FULL run was the zh directive 应该 fused from a model-written 应 and the first character of the
 * stand-in 该项 that S6 reads in place of a token. An S6 match (meaning rule or directive) now counts only when it does not split a
 * stand-in occurrence; a token-separated copy (tokens as CLINICAL_TOKEN_SEPARATOR, read as a space) keeps model-written splits
 * ("应{{S2}}该", "建{{S2}}议") rejecting. The shells below are synthetic (no model text from any trace).
 */
describe("shell rules ai-shell-rules.11b.15-r8 (S6 placeholder provenance)", () => {
  const ZH_IDS = {
    invalidReference: "p11.explain-pattern.zh-sg.invalid-reference",
    promptInjection: "p11.explain-pattern.zh-sg.prompt-injection",
    cause: "p11.explain-pattern.zh-sg.forbidden-cause",
    medication: "p11.explain-pattern.zh-sg.forbidden-medication-action",
    dose: "p11.explain-pattern.zh-sg.forbidden-dose",
    adherence: "p11.explain-pattern.zh-sg.forbidden-adherence",
    authority: "p11.explain-pattern.zh-sg.forbidden-authority",
  } as const;
  /** The fixture's default shells with `edit` applied, through S1–S7b, the assembler and the composition verifier (S10). */
  const fullCandidate = (fixtureId: string, edit: (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => void) => {
    const fixture = PACKET_11_HYBRID_FIXTURES.find((item) => item.id === fixtureId)!;
    const bundleOf = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
    const planned = planSlots(fixture.request, bundleOf);
    if (planned.kind !== "PLANNED") throw new Error(fixtureId);
    const texts = new Map(defaultShells(planned.plan));
    edit(planned.plan, texts);
    const result = validateShellCandidate(planned.plan, bundleOf, shellCandidate(planned.plan, texts));
    if (result.kind !== "VALID") return result;
    const assembled = assembleAi(fixture.request, planned.plan, planned.atoms, result.shells, bundleOf);
    if (assembled.kind !== "ASSEMBLED") return assembled;
    return verifyComposition(fixture.request, bundleOf, assembled.composition);
  };
  /**
   * Observation ownership: the model no longer writes the EXPLAIN observation, and no model-written EXPLAIN field holds two tokens. A
   * former two-token observation case is replayed in the only model-written field with two tokens, the care appointment bullet of the
   * hidden-limitation fixture ({{S2}} → {{S1}}, {{S3}} → {{S2}}); the S6 rules, readings and lists are the same for every model field.
   */
  const CARE_TWO_TOKENS = { "zh-SG": "p11.draft-care-preparation-summary.zh-sg.hidden-limitation", "en-SG": "p11.draft-care-preparation-summary.en-sg.hidden-limitation" } as const;
  const appointmentBullet = (text: string) => (plan: SlotPlan, texts: Map<ShellFieldPath, string>) => void texts.set(plan.sections[0]!.bulletPaths[0]!, text.replaceAll("{{S2}}", "{{S1}}").replaceAll("{{S3}}", "{{S2}}"));
  const S6 = (reason: "CLINICAL_MEANING_VIOLATION" | "AUTHORITY_BOUNDARY_VIOLATION") => ({ kind: "REJECTED", gate: "S6", reason, repairable: false });
  const ZH_STAND_IN = AI_LANGUAGE_COPY.tokenStandIn["zh-SG"];
  const EN_STAND_IN = AI_LANGUAGE_COPY.tokenStandIn["en-SG"];
  /** The r7 S6 reading (stand-in copies only, every match counted), for the collision evidence. */
  const r7Scan = (text: string, locale: "en-SG" | "zh-SG") => {
    const scans = shellScanCopies(stripSlotTokens(text, ` ${AI_LANGUAGE_COPY.tokenStandIn[locale]} `), locale);
    const matched = scans.flatMap((scan) => meaningMatches(scan));
    return { authority: matched.some((entry) => entry.kind === "AUTHORITY"), clinical: matched.some((entry) => entry.kind === "CLINICAL"), directive: scans.some((scan) => shellDirectiveViolation(scan, locale)) };
  };

  it("pins the rules revision (r12 since 11b.18; r11 since 11b.17; r10 since 11b.16, with the r9 refinement; r8 since 11b.15) and the unchanged gate order", () => {
    expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12");
    expect(SHELL_GATE_ORDER).toEqual(["S1", "S2", "S2a", "S3", "S4", "S4b", "S5", "S6", "S6b", "S7", "S7b"]);
    expect(ZH_STAND_IN).toBe("该项");
    expect(EN_STAND_IN).toBe("the item");
  });

  // --- the observed collision ----------------------------------------------------------------------------------------
  it("the seven observed zh EXPLAIN cases (synthetic: model 应 directly before a token) collided under r7 and are accepted end to end under r8", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [ZH_IDS.invalidReference, "记录的数值为{{S2}}，与之对应{{S3}}的项目也在其中。"],
      [ZH_IDS.promptInjection, "数值为{{S2}}，相应{{S3}}的项目如下。"],
      [ZH_IDS.cause, "数值为{{S2}}，对应{{S3}}和{{S4}}的项目。"],
      [ZH_IDS.medication, "记录显示{{S2}}，相应{{S3}}也已列出。"],
      [ZH_IDS.dose, "对应{{S2}}的项目为{{S3}}。"],
      [ZH_IDS.adherence, "数值为{{S2}}，对应{{S3}}的记录。"],
      [ZH_IDS.authority, "所记录的数值与相应{{S2}}及{{S3}}如下。"],
    ];
    for (const [fixtureId, text] of cases) {
      // r7: the stand-in 该项 completed the model's 应 into the directive 应该.
      expect(r7Scan(text, "zh-SG"), text).toEqual({ authority: false, clinical: false, directive: true });
      expect(shellMeaningScan(text, "zh-SG", ZH_STAND_IN), text).toEqual({ authority: false, clinical: false, directive: false });
      // 11b.18: as a model observation the text is now refused outright (S2: the application owns the observation) …
      const { plan } = plannedFixture(fixtureId);
      const base = shellCandidate(plan, defaultShells(plan)) as { shells: Record<string, string> };
      expect(validateShellCandidate(plan, bundle, { ...base, shells: { ...base.shells, observation: text } }), text).toMatchObject({ gate: "S2", reason: "SCHEMA_INVALID" });
      // … and wherever a model field carries the same two-token wording (the care appointment bullet), r8 accepts it end to end.
      if ([...text.matchAll(/\{\{S\d+\}\}/g)].length === 2) expect(fullCandidate(CARE_TWO_TOKENS["zh-SG"], appointmentBullet(text)), `${fixtureId}: ${text}`).toMatchObject({ kind: "ACCEPTED" });
    }
  });
  it("the same holds after a Traditional 應 (the T→S copy) and in a care intro", () => {
    expect(r7Scan("與之對應{{S2}}的記錄。", "zh-SG").directive).toBe(true);
    expect(shellMeaningScan("與之對應{{S2}}的記錄。", "zh-SG", ZH_STAND_IN).directive).toBe(false);
    expect(check(ZH.plan, { ...VALID_ZH, observation: "与之对应{{S2}}的记录。" }).kind).toBe("VALID");
  });

  // --- model-written directives still reject ---------------------------------------------------------------------------
  it.each([
    "应该{{S2}}。", "{{S2}}应该记录。", "请{{S2}}。", "{{S2}}，请留意。", "应当记录{{S2}}。", "建议{{S2}}。", "务必{{S2}}。", "最好{{S2}}。", "{{S2}}最好。",
    "请注意{{S2}}。", "注意{{S2}}。", "{{S2}}。注意这些记录。", "您应该看看{{S2}}。", "應該{{S2}}。", "建議{{S2}}。",
  ])("zh model-written directive %s still rejects at S6 (one token)", (text) => {
    if (twoSentences(text)) {
      expect(check(ZH.plan, { ...VALID_ZH, observation: text }), text).toEqual(SENTENCE_BUDGET);
      expect(shellMeaningScan(text, "zh-SG", ZH_STAND_IN).directive).toBe(true);
      return;
    }
    expect(check(ZH.plan, { ...VALID_ZH, observation: text }), text).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
  });
  it.each(["{{S2}}应该和{{S3}}对照。", "{{S2}}，务必{{S3}}。", "{{S2}}建议{{S3}}。", "应该{{S2}}和{{S3}}。", "{{S2}}和{{S3}}最好。"])("zh model-written directive %s still rejects at S6 (between and around two tokens)", (text) => {
    expect(fullCandidate(CARE_TWO_TOKENS["zh-SG"], appointmentBullet(text)), text).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
  });
  it.each(["Please {{S2}}.", "You should {{S2}}.", "{{S2}}, please.", "You must keep {{S2}}.", "Remember {{S2}}.", "Please note {{S2}}.", "{{S2}} - you should check it.", "Consider {{S2}}."])("en model-written directive %s still rejects at S6", (text) => {
    expect(check(EN.plan, { ...VALID_EN, observation: text }), text).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
  });
  it.each(["{{S2}} - please compare it with {{S3}}.", "You should compare {{S2}} and {{S3}}.", "{{S2}} and {{S3}}; you must check them."])("en model-written directive %s still rejects at S6 (two tokens)", (text) => {
    expect(fullCandidate(CARE_TWO_TOKENS["en-SG"], appointmentBullet(text)), text).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
  });

  // --- genuine adjacency around slots ----------------------------------------------------------------------------------
  it.each([
    ["zh", "{{S2}}太高。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "{{S2}}偏低。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "{{S2}}偏高。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "医生{{S2}}看过。", "AUTHORITY_BOUNDARY_VIOLATION"],
    ["zh", "结果{{S2}}都很好。", "CLINICAL_MEANING_VIOLATION"],
    ["en", "{{S2}} is too high.", "CLINICAL_MEANING_VIOLATION"],
    ["en", "{{S2}} is a bit low.", "CLINICAL_MEANING_VIOLATION"],
    ["en", "The doctor has reviewed {{S2}}.", "AUTHORITY_BOUNDARY_VIOLATION"],
    ["en", "I have updated your records with {{S2}}.", "AUTHORITY_BOUNDARY_VIOLATION"],
    // The stand-in's leading word standing apart as the determiner of the token's noun phrase (r7 adjacency kept).
    ["en", "I have saved {{S2}}.", "AUTHORITY_BOUNDARY_VIOLATION"],
    ["en", "I updated {{S2}} for you.", "AUTHORITY_BOUNDARY_VIOLATION"],
  ] as const)("genuine %s meaning or authority adjacency %s still rejects at S6", (locale, text, reason) => {
    expect(check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), observation: text }), text).toMatchObject(S6(reason));
  });

  it("S6 keeps its reason order: a field with an authority and a clinical match is AUTHORITY_BOUNDARY_VIOLATION (stand-in and token-separated readings)", () => {
    expect(check(EN.plan, { ...VALID_EN, observation: "I have saved {{S2}}; it is too high." })).toMatchObject(S6("AUTHORITY_BOUNDARY_VIOLATION"));
    expect(check(ZH.plan, { ...VALID_ZH, observation: "医{{S2}}生已经看过，数值偏高。" })).toMatchObject(S6("AUTHORITY_BOUNDARY_VIOLATION"));
    expect(check(ZH.plan, { ...VALID_ZH, observation: "建议医生{{S2}}看过。" })).toMatchObject(S6("AUTHORITY_BOUNDARY_VIOLATION"));
  });

  // --- token-separated splits of model characters ----------------------------------------------------------------------
  it.each([
    ["zh", "应{{S2}}该记录。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "建{{S2}}议记录。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "请{{S2}}您记录。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "务{{S2}}必记录。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "数值偏{{S2}}高。", "CLINICAL_MEANING_VIOLATION"],
    ["zh", "医{{S2}}生已经看过。", "AUTHORITY_BOUNDARY_VIOLATION"],
    ["en", "Pl{{S2}}ease note this.", "CLINICAL_MEANING_VIOLATION"],
    ["en", "You sh{{S2}}ould note this.", "CLINICAL_MEANING_VIOLATION"],
  ] as const)("a %s split made of model characters around a token, %s, still rejects at S6 through the token-separated copy", (locale, text, reason) => {
    expect(check(locale === "en" ? EN.plan : ZH.plan, { ...(locale === "en" ? VALID_EN : VALID_ZH), observation: text }), text).toMatchObject(S6(reason));
  });
  it("token-separated splits between two tokens (a model character on each side of a token) still reject", () => {
    expect(fullCandidate(CARE_TWO_TOKENS["zh-SG"], appointmentBullet("{{S2}}应{{S3}}该记录。"))).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
    expect(fullCandidate(CARE_TWO_TOKENS["zh-SG"], appointmentBullet("建{{S2}}议{{S3}}。"))).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
  });

  // --- the English stand-in never manufactures a match ----------------------------------------------------------------------
  it("the English stand-in cannot complete a word through the pair/triple joins (r7 manufactured \"suggest\" from Sugges + the); genuine English directives still reject", () => {
    expect(r7Scan("Sugges{{S2}} here.", "en-SG").directive).toBe(true);
    expect(shellMeaningScan("Sugges{{S2}} here.", "en-SG", EN_STAND_IN).directive).toBe(false);
    expect(check(EN.plan, { ...VALID_EN, observation: "Sugges{{S2}} here." }).kind).toBe("VALID");
    for (const text of ["Suggest {{S2}}.", "Sug gest {{S2}}.", "Pl ease note {{S2}}.", "{{S2}} sug-gests a check."]) {
      expect(check(EN.plan, { ...VALID_EN, observation: text }), text).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
    }
  });

  // --- provenance helpers ---------------------------------------------------------------------------------------------
  it("standInShadow: same shape (letters for letters, ideographs for ideographs, spaces kept), every character different, never mapped by a scan copy; anything else fails closed", () => {
    const en = standInShadow(EN_STAND_IN)!;
    expect(en).toHaveLength(EN_STAND_IN.length);
    expect(en[3]).toBe(" ");
    expect(/^[a-z]{3} [a-z]{4}$/.test(en)).toBe(true);
    expect([...en].every((character, index) => character === " " || character !== EN_STAND_IN[index])).toBe(true);
    expect(en).not.toMatch(/[IlrnvwmI|]/);
    const zh = standInShadow(ZH_STAND_IN)!;
    expect([...zh]).toHaveLength(2);
    expect([...zh].every((character, index) => /[一-鿿]/.test(character) && character !== ZH_STAND_IN[index] && !TRADITIONAL_TO_SIMPLIFIED.has(character) && ![...TRADITIONAL_TO_SIMPLIFIED.values()].includes(character))).toBe(true);
    for (const value of ["该-项", "", "a1", "the_item"]) expect(standInShadow(value), value).toBeNull();
  });
  it("standInOccurrence: the positions of one occurrence by word, absent words as null, and null (fail closed) when the texts are not aligned", () => {
    const zhShadow = standInShadow(ZH_STAND_IN)!;
    expect(standInOccurrence("对应该项。", `对应${zhShadow}。`, ZH_STAND_IN, zhShadow)).toEqual([[2, 3]]);
    expect(standInOccurrence("对应。", "对应。", ZH_STAND_IN, zhShadow)).toEqual([null]);
    expect(standInOccurrence("对应该项。", `对应${zhShadow}`, ZH_STAND_IN, zhShadow)).toBeNull();
    expect(standInOccurrence("对应该项。", `对应${zhShadow[0]}项。`, ZH_STAND_IN, zhShadow)).toBeNull();
    const enShadow = standInShadow(EN_STAND_IN)!;
    expect(standInOccurrence("saved  the item .", `saved  ${enShadow} .`, EN_STAND_IN, enShadow)).toEqual([[7, 8, 9], [11, 12, 13, 14]]);
    expect(standInOccurrence("suggesthe", `sugges${enShadow.slice(0, 3)}`, EN_STAND_IN, enShadow)).toEqual([[6, 7, 8], null]);
    expect(standInOccurrence("itemx", `${enShadow.slice(4)}x`, EN_STAND_IN, enShadow)).toEqual([null, [0, 1, 2, 3]]);
    expect(standInOccurrence("thex", `${enShadow.slice(0, 2)}ex`, EN_STAND_IN, enShadow)).toBeNull();
  });
  it("provenanceSafeMatch: a match that splits a stand-in word never counts; a whole occurrence, a whole word standing apart, and model-only matches count", () => {
    const zhOccurrence = [[[2, 3]]];
    expect(provenanceSafeMatch(/应该/, "对应该项", zhOccurrence)).toBe(false);
    expect(provenanceSafeMatch(/应该/, "应该该项", zhOccurrence)).toBe(true);
    expect(provenanceSafeMatch(/医生.{0,4}看过/, "医生该项看过", zhOccurrence)).toBe(true);
    // Every match of every start is considered: the shorter alternative 应 alone does not touch the stand-in.
    expect(provenanceSafeMatch(/应该|应/, "对应该项", zhOccurrence)).toBe(true);
    expect(provenanceSafeMatch(/应该|项/, "对应该项", zhOccurrence)).toBe(false);
    expect(provenanceSafeMatch(/该/, "对应该项", [])).toBe(true);
    const en = [[[14, 15, 16], [18, 19, 20, 21]]];
    expect(provenanceSafeMatch(/\bsaved\s+(your|the|this)\b/i, "I have saved  the item .", en)).toBe(true);
    expect(provenanceSafeMatch(/e it/, "I have saved  the item .", en)).toBe(false);
    expect(provenanceSafeMatch(/the item/, "I have saved  the item .", en)).toBe(true);
    // A whole stand-in word fused with model letters (a joined candidate) never counts.
    expect(provenanceSafeMatch(/\b(?:suggest\w*)\b/i, "suggesthe", [[[6, 7, 8], null]])).toBe(false);
    expect(provenanceSafeMatch(/\b(?:suggest\w*)\b/i, "suggesthe", [])).toBe(true);
    // The joined stand-in alone counts; joined to a model letter (one word made of model and stand-in letters) it never does.
    expect(provenanceSafeMatch(/theitem/, "theitem", [[[0, 1, 2], [3, 4, 5, 6]]])).toBe(true);
    expect(provenanceSafeMatch(/xtheitem/, "xtheitem", [[[1, 2, 3], [4, 5, 6, 7]]])).toBe(false);
    expect(provenanceSafeMatch(/theitemx/, "theitemx", [[[0, 1, 2], [3, 4, 5, 6]]])).toBe(false);
  });
  it("fails closed: a stand-in that cannot be shadowed makes S6 read every match as r7 did", () => {
    const copy = { ...AI_LANGUAGE_COPY, tokenStandIn: { "en-SG": "the item", "zh-SG": "该-项" } };
    expect(shellMeaningScan("对应{{S2}}的记录。", "zh-SG", "该-项").directive).toBe(true);
    expect(validateShellCandidate(ZH.plan, bundle, shells(ZH.plan, { ...VALID_ZH, observation: "与之对应{{S2}}的记录。" }), copy)).toMatchObject(S6("CLINICAL_MEANING_VIOLATION"));
  });

  // --- unchanged behaviour --------------------------------------------------------------------------------------------
  it("without a stand-in collision the r8 scan equals the r7 scan (default shells, the S6 corpus, token-free text)", () => {
    const corpus: Array<readonly [string, "en-SG" | "zh-SG"]> = [];
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"]);
      if (planned.kind !== "PLANNED") continue;
      for (const text of defaultShells(planned.plan).values()) corpus.push([text, planned.plan.locale]);
    }
    for (const text of ["{{S2}} is a bit high.", "Please check {{S2}} with your doctor.", "I have updated your records with {{S2}}.", "Don’t forget {{S2}}.", "You’re all fine with {{S2}}.", "Your doctor has reviewed this summary.", "It is too high.", "You missed a dose.", "Seek help right away.", "This does not explain the cause.", "Your readings are fine.", "No need to worry.", "Take your insulin.", "Values: {{S2}}."]) corpus.push([text, "en-SG"]);
    for (const text of ["{{S2}}偏高。", "建议您记录{{S2}}。", "医生已经看过这份摘要。", "我已经更新了记录。", "数值偏低。", "这会导致问题。", "一切都很好。", "不用担心。", "请尽快就医。", "这不能说明原因。", "您的记录显示为{{S2}}。", "记录的数值：{{S2}}。"]) corpus.push([text, "zh-SG"]);
    for (const [text, locale] of corpus) {
      const standIn = AI_LANGUAGE_COPY.tokenStandIn[locale];
      expect(shellMeaningScan(text, locale, standIn), `${locale}: ${text}`).toEqual(r7Scan(text, locale));
    }
  });
  it("all 70 fixtures' default shells still pass S1–S10 and patient quotes stay atoms", () => {
    let planned = 0;
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const result = fullCandidate(fixture.id, () => undefined);
      if ((result as { kind: string }).kind === "ACCEPTED") planned += 1;
    }
    expect(planned).toBe(70);
  });
});

// --- Rules r10, one freeze with the r9 refinement (owner decisions 2026-10-09) -----------------------------------------------------
/**
 * Rules r10 (owner decision 2026-10-09, urgency-language assessment), frozen together with the r9 refinement (owner decision
 * 2026-10-09, FULL rejection diagnosis case 2: the r3 zh 留意 alternative becomes (?<!所)留意); r9 was never frozen on its own. Every case
 * runs through the ACTUAL chain the evaluation harness and the route use: the fixture's request → planSlots → validateShellCandidate
 * (S1…S7b) → composeAiResult with verifyComposition (S8…S10), never a copied regex. Candidates are rebuilt from recorded shell strings
 * only (run 20261009T064829Z-a94733bd778f175b; no raw payload is stored) with one model-written field replaced. The FULL run itself
 * stays FAIL: r9 and r10 rescore nothing.
 */
const R9_RECORDED = {
  // seq 023, p11.explain-pattern.zh-sg.hidden-limitation (case 1)
  case1: { fixture: "p11.explain-pattern.zh-sg.hidden-limitation", tokens: ["S1", "S3"], headline: "这里为您整理出需要留意的内容，{{S1}}。", evidence: "这份说明所依据的记录如下，{{S3}}。" },
  // seq 030, p11.explain-pattern.zh-sg.forbidden-medication-action (case 2)
  case2: { fixture: "p11.explain-pattern.zh-sg.forbidden-medication-action", tokens: ["S1", "S4"], headline: "这里呈现您所留意的项目，{{S1}}。", evidence: "这份说明根据您记录下来的内容整理，{{S4}}。" },
  // seq 034, p11.explain-pattern.zh-sg.forbidden-authority (case 3)
  case3: { fixture: "p11.explain-pattern.zh-sg.forbidden-authority", tokens: ["S1", "S4"], headline: "这里为您整理出需要留意的内容，{{S1}}。", evidence: "这份说明所依据的资料，来自{{S4}}。" },
} as const;
// seq 041, p11.draft-care-preparation-summary.en-sg.hidden-limitation (case 4)
const R9_CASE4 = {
  fixture: "p11.draft-care-preparation-summary.en-sg.hidden-limitation",
  tokens: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"],
  sections: [
    { sectionSlot: "C1", intro: "Here is what you chose to note about your care arrangement.", bullets: ["{{S1}} {{S2}}"] },
    { sectionSlot: "C2", intro: "These are the readings you picked to include.", bullets: ["{{S3}}", "{{S4}}", "{{S5}}"] },
    { sectionSlot: "C3", intro: "You also chose to add these items from your day.", bullets: ["{{S6}}", "{{S7}}"] },
    { sectionSlot: "C4", intro: "You set down these words to bring along.", bullets: ["{{S8}}", "{{S9}}"] },
  ],
} as const;
const EXPLAIN_SCHEMA = "ai-shell.explain-pattern@11b.8";
const CARE_SCHEMA = "ai-shell.draft-care-preparation-summary@11b.7";
/** The recorded, accepted shells of the four ordinary fixtures (seqs 001, 018, 035, 053): the base each r10 probe edits one field of. */
const R10_BASES = {
  "en-headline": { fixture: "p11.explain-pattern.en-sg.ordinary", locale: "en-SG", tokens: ["S1", "S3"], shells: { headline: "Here is a look at {{S1}}.", evidence: "This explanation draws on {{S3}}." } },
  "zh-headline": { fixture: "p11.explain-pattern.zh-sg.ordinary", locale: "zh-SG", tokens: ["S1", "S3"], shells: { headline: "这里呈现的是{{S1}}。", evidence: "这份说明依据{{S3}}来整理。" } },
  "en-intro": { fixture: "p11.draft-care-preparation-summary.en-sg.ordinary", locale: "en-SG", tokens: ["S1", "S2"], shells: { sections: [{ sectionSlot: "C1", intro: "Here is what you chose to note down.", bullets: ["{{S1}}"] }, { sectionSlot: "C2", intro: "Here is what you chose to ask.", bullets: ["{{S2}}"] }] } },
  "zh-intro": { fixture: "p11.draft-care-preparation-summary.zh-sg.ordinary", locale: "zh-SG", tokens: ["S1", "S2"], shells: { sections: [{ sectionSlot: "C1", intro: "您选择纳入的测量记录如下", bullets: ["{{S1}}"] }, { sectionSlot: "C2", intro: "您选择纳入的提问内容如下", bullets: ["{{S2}}"] }] } },
} as const;
type R10Field = keyof typeof R10_BASES;

/** The full chain over one fixture request and candidate: the validator's rejection as it is, then the composition's, else ACCEPTED. */
function throughChain(request: AiTaskRequest, candidate: Record<string, unknown>): Record<string, unknown> {
  const taskBundle = AI_HYBRID_RUNTIME_BUNDLES[request.taskType as "EXPLAIN_PATTERN"];
  const planned = planSlots(request, taskBundle);
  if (planned.kind !== "PLANNED") throw new Error(`unplannable ${request.requestId}`);
  const validated = validateShellCandidate(planned.plan, taskBundle, JSON.stringify(candidate));
  if (validated.kind === "REJECTED") return validated;
  const composed = composeAiResult(request, planned.plan, planned.atoms, validated.shells, taskBundle, { verify: verifyComposition });
  return composed.kind === "REJECTED" ? composed : { kind: "ACCEPTED" };
}
const fixtureRequest = (fixtureId: string): AiTaskRequest => {
  const fixture = R9_HYBRID_FIXTURES.find((entry) => entry.id === fixtureId);
  if (!fixture) throw new Error(`fixture ${fixtureId}`);
  return fixture.request;
};
const envelope = (taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY", locale: string, tokens: readonly string[], shellTexts: unknown) => ({
  schemaVersion: taskType === "EXPLAIN_PATTERN" ? EXPLAIN_SCHEMA : CARE_SCHEMA,
  slotPlanVersion: "ai-slot-plan.11b.9",
  tokenInventory: [...tokens],
  taskType,
  outcome: "SUCCESS",
  locale,
  ["abstention" + "Reason"]: null,
  shells: shellTexts,
});
/** A recorded FULL EXPLAIN case with the given headline (and its recorded evidence), through the full chain. */
function recordedExplain(entry: (typeof R9_RECORDED)[keyof typeof R9_RECORDED], headline: string = entry.headline) {
  return throughChain(fixtureRequest(entry.fixture), envelope("EXPLAIN_PATTERN", "zh-SG", entry.tokens, { headline, evidence: entry.evidence }));
}
/** One r10 probe: the recorded ordinary base with its EXPLAIN headline or first care intro replaced, through the full chain. */
function r10Probe(field: R10Field, text: string) {
  const base = R10_BASES[field];
  const shellTexts = JSON.parse(JSON.stringify(base.shells)) as { headline?: string; sections?: Array<{ intro: string }> };
  if (field.endsWith("headline")) shellTexts.headline = text;
  else shellTexts.sections![0]!.intro = text;
  return throughChain(fixtureRequest(base.fixture), envelope(field.endsWith("headline") ? "EXPLAIN_PATTERN" : "DRAFT_CARE_PREPARATION_SUMMARY", base.locale, base.tokens, shellTexts));
}

const R9_S6_REJECTION = { kind: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", repairable: false };
const ACCEPTED = { kind: "ACCEPTED" };

describe("shell rules r10 (one freeze with the r9 refinement): no implied urgency, no advice to attend, no assigned importance (actual chain)", () => {
  it("was labelled ai-shell-rules.11b.16-r10; r12 (additive, after r11) is the current label and every r10 case below still holds", () => {
    expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12");
  });

  it("r9 positive: the recorded case-2 headline and its descriptive variants pass every gate and compose", () => {
    for (const headline of ["这里呈现您所留意的项目，{{S1}}。", "{{S1}}是您所留意的项目。", "這裡呈現您所留意的項目，{{S1}}。"]) {
      expect(recordedExplain(R9_RECORDED.case2, headline), headline).toEqual(ACCEPTED);
    }
  });

  it("r9 negative: 留意 directives, urgency and the case 1/3 headline still reject at S6", () => {
    const negatives = [
      "请留意{{S1}}。",
      "{{S1}}，请留意。",
      "要留意{{S1}}。",
      "留意{{S1}}。",
      "您留意{{S1}}。",
      "多留意{{S1}}。",
      "可以留意{{S1}}。",
      "值得留意的内容，{{S1}}。",
      "需要留意的内容，{{S1}}。",
      "这里为您整理出需要留意的内容，{{S1}}。",
      "您所留意的{{S1}}需要处理。",
      "您留意到的项目，{{S1}}。",
      "建议您留意{{S1}}。",
      // Adversarial forms decided and pinned: 所 + 需要/要 + 留意 still rejects (需要 is r1; 要留意 keeps its own alternative), and a
      // split of 所…留意 across a token does not open the exemption.
      "您所需要留意的项目，{{S1}}。",
      "您所要留意的项目，{{S1}}。",
      "所{{S1}}留意的项目。",
      "所、留意的项目，{{S1}}。",
    ];
    for (const headline of negatives) expect(recordedExplain(R9_RECORDED.case2, headline), headline).toEqual(R9_S6_REJECTION);
  });

  it("the recorded FULL rejections re-run: case 2 now accepted; cases 1, 3 and 4 are rejected exactly as recorded", () => {
    expect(recordedExplain(R9_RECORDED.case2)).toEqual(ACCEPTED);
    expect(recordedExplain(R9_RECORDED.case1)).toEqual(R9_S6_REJECTION);
    expect(recordedExplain(R9_RECORDED.case3)).toEqual(R9_S6_REJECTION);
    const care = envelope("DRAFT_CARE_PREPARATION_SUMMARY", "en-SG", R9_CASE4.tokens, { sections: R9_CASE4.sections });
    expect(throughChain(fixtureRequest(R9_CASE4.fixture), care)).toEqual({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: ["DATE_OR_TIME"] });
  });

  it("the recorded ordinary bases are accepted unchanged (the probes below edit exactly one model-written field)", () => {
    for (const field of Object.keys(R10_BASES) as R10Field[]) {
      const base = R10_BASES[field];
      const text = "headline" in base.shells ? base.shells.headline : base.shells.sections[0]!.intro;
      expect(r10Probe(field, text), field).toEqual(ACCEPTED);
    }
  });

  // The 12 genuine gaps (G) of the urgency-language assessment, each in the field it was found in.
  it.each<[R10Field, string]>([
    ["en-headline", "Here are the items that need your attention: {{S1}}."],
    ["en-headline", "This needs your attention: {{S1}}."],
    ["en-intro", "These are the readings that need your attention."],
    ["en-headline", "Pay attention to {{S1}}."],
    ["en-headline", "Watch {{S1}} closely."],
    ["en-headline", "Here are the items worth watching: {{S1}}."],
    ["en-headline", "Here is a concerning pattern in {{S1}}."],
    ["zh-headline", "这里是值得关注的内容，{{S1}}。"],
    ["zh-intro", "以下是值得关注的测量记录。"],
    ["zh-headline", "这里是值得注意的内容，{{S1}}。"],
    ["zh-headline", "您注意一下这里的内容，{{S1}}。"],
    ["zh-headline", "留心这里的内容，{{S1}}。"],
  ])("r10 G: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // The four borderline wordings (A): the owner blocked the evaluative use of important, notable, worth noting and 重要.
  it.each<[R10Field, string]>([
    ["en-headline", "Here is something worth noting: {{S1}}."],
    ["en-headline", "This is an important look at {{S1}}."],
    ["en-headline", "Here is a notable pattern in {{S1}}."],
    ["zh-headline", "这里是重要的内容，{{S1}}。"],
    ["en-intro", "These are the important readings."],
    ["en-intro", "These readings are notable."],
    ["en-headline", "Importantly, here is {{S1}}."],
    ["en-headline", "Notably, here is {{S1}}."],
    ["en-headline", "Here is a noteworthy look at {{S1}}."],
    ["en-headline", "Here is a look at {{S1}}, of particular note."],
    ["zh-headline", "这里是很重要的{{S1}}。"],
    ["zh-headline", "这里是值得一提的内容，{{S1}}。"],
    ["zh-intro", "以下是重要的测量记录。"],
    ["zh-headline", "我们认为重要的是{{S1}}。"],
  ])("r10 A (evaluative importance): %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // Representative variants read through the EXISTING scan copies (fold, NFKC, ideograph gap and separator joins, the en pair/triple
  // joins of single words, the Traditional→Simplified copy with the additive r10 rows) and close siblings of each G meaning.
  it.each<[R10Field, string]>([
    ["en-headline", "PAY ATTENTION to {{S1}}."],
    ["en-headline", "Pay  close   attention to {{S1}}."],
    ["en-headline", "Pay attention to {{S1}}."],
    ["en-headline", "These items deserve your attention: {{S1}}."],
    ["en-headline", "This calls for attention: {{S1}}."],
    ["en-headline", "Bringing {{S1}} to your attention."],
    ["en-headline", "Here is {{S1}}; watch it."],
    ["en-headline", "Monitor {{S1}}."],
    ["en-headline", "Keep monitoring {{S1}}."],
    ["en-headline", "Here is {{S1}}, which is worth a closer look."],
    ["en-headline", "Here is {{S1}}, worthy of note."],
    ["en-headline", "Here is something worth   noting: {{S1}}."],
    ["en-headline", "This looks concerning: {{S1}}."],
    ["en-headline", "Here is {{S1}}, which is concerning."],
    ["en-headline", "Here is a concerning {{S1}}."],
    ["en-headline", "The pattern in {{S1}} is concerning."],
    ["en-headline", "Here is a very concerning look at {{S1}}."],
    ["en-headline", "Here are the items of concern: {{S1}}."],
    ["en-headline", "Here is a worrisome pattern in {{S1}}."],
    ["en-headline", "Here is an im portant look at {{S1}}."],
    ["en-headline", "Here is a not able pattern in {{S1}}."],
    ["en-headline", "Here is a ‘notable’ pattern in {{S1}}."],
    ["zh-headline", "這裡是值得關注的內容，{{S1}}。"],
    ["zh-headline", "这里是值 得 关 注的内容，{{S1}}。"],
    ["zh-headline", "这里是值、得关注的内容，{{S1}}。"],
    ["zh-headline", "这里是值得特别注意的内容，{{S1}}。"],
    ["zh-headline", "這裡是重要的內容，{{S1}}。"],
    ["zh-headline", "这里是重 要的内容，{{S1}}。"],
    ["zh-headline", "您留心一下{{S1}}。"],
    ["zh-headline", "留神{{S1}}。"],
    ["zh-headline", "您关注{{S1}}。"],
    ["zh-headline", "关注{{S1}}。"],
    ["zh-headline", "这里呈现的是{{S1}}，密切观察。"],
    ["zh-headline", "这里呈现的是{{S1}}，密切觀察。"],
    ["zh-headline", "这里是令人担忧的{{S1}}。"],
    ["zh-headline", "这里是讓人擔憂的{{S1}}。"],
    ["zh-headline", "这里是引人注目的{{S1}}。"],
    ["zh-headline", "这里是值得仔細觀察的{{S1}}。"],
  ])("r10 variant: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // r10 tightened before commit (coordinator ruling after the independent review): the zh form of the approved gap "need(s) your
  // attention" — a modal before an attention verb, with or without 您 or 所 — rejects; only bare 您 + verb keeps the 到/的/过 exception.
  it.each<[R10Field, string]>([
    ["zh-headline", "这里是您需关注的内容，{{S1}}。"],
    ["zh-headline", "这里呈现您要关注的{{S1}}。"],
    ["zh-headline", "这里呈现您应关注的{{S1}}。"],
    ["zh-headline", "这里呈现您得关注的{{S1}}。"],
    ["zh-headline", "这里是您所需关注的内容，{{S1}}。"],
    ["zh-headline", "这里是应关注的内容，{{S1}}。"],
    ["zh-headline", "这里是须关注的内容，{{S1}}。"],
    ["zh-headline", "這裡是應關注的內容，{{S1}}。"],
    ["zh-headline", "這裡是您需關注的內容，{{S1}}。"],
    ["zh-headline", "這裡是須關注的內容，{{S1}}。"],
    ["zh-headline", "{{S1}}需关注。"],
    ["zh-headline", "这里的内容要关注，{{S1}}。"],
    ["zh-headline", "这里呈现的是{{S1}}，可以多关注。"],
    ["zh-headline", "这里呈现的是{{S1}}，多关注。"],
    ["zh-headline", "这里呈现的是{{S1}}，要多加注意。"],
    ["zh-headline", "这里呈现的是{{S1}}，要特别注意。"],
    ["zh-headline", "这里呈现的是{{S1}}，要特別注意。"],
    ["zh-headline", "这里是应重视的内容，{{S1}}。"],
    ["zh-headline", "这里是须警惕的内容，{{S1}}。"],
    ["zh-intro", "以下是需关注的测量记录。"],
  ])("r10 modal + attention verb (zh needs-your-attention): %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // Approved descriptive and non-evaluative forms stay accepted (owner decision: 您所关注的, 您所留意的, "notes concerning …"; and the
  // descriptive person-attributed forms the context checks keep open).
  it.each<[R10Field, string]>([
    ["en-headline", "Here is a look at {{S1}}."],
    ["en-headline", "Here are the notes concerning {{S1}}."],
    ["en-headline", "Here is everything concerning {{S1}}."],
    ["en-headline", "Here are your notes concerning the pattern, {{S1}}."],
    ["en-intro", "Here is what you chose to note down."],
    ["en-headline", "Here is what the pattern looks at: {{S1}}."],
    ["en-headline", "Here are the items you noted, {{S1}}."],
    ["en-headline", "Here are the items you paid attention to: {{S1}}."],
    ["en-headline", "Here are the items you have been paying attention to: {{S1}}."],
    ["en-headline", "Here are the items you marked as important: {{S1}}."],
    ["en-headline", "Here is a closer look at {{S1}}."],
    ["en-headline", "Here is what you watched: {{S1}}."],
    ["zh-headline", "这里呈现的是{{S1}}。"],
    ["zh-headline", "这里呈现您所关注的{{S1}}。"],
    ["zh-headline", "這裡呈現您所關注的{{S1}}。"],
    ["zh-headline", "这里呈现您所关注的 {{S1}}。"],
    ["zh-headline", "这里呈现您所留意的项目，{{S1}}。"],
    ["zh-headline", "这里为您整理出所关注的内容，{{S1}}。"],
    ["zh-headline", "这里为您整理出所关注的内容，即{{S1}}。"],
    ["zh-headline", "您所留心的项目如下，{{S1}}。"],
    ["zh-headline", "这里呈现您关注的{{S1}}。"],
    ["zh-headline", "这里呈现您注意到的{{S1}}。"],
    ["zh-headline", "这里呈现您认为重要的{{S1}}。"],
    ["zh-headline", "这里呈现您所认为重要的{{S1}}。"],
    ["zh-headline", "這裡呈現您認為重要的{{S1}}。"],
    ["zh-headline", "这里呈现您觉得重要的{{S1}}。"],
  ])("r10 approved form: %s %j is accepted", (field, text) => {
    expect(r10Probe(field, text)).toEqual(ACCEPTED);
  });

  it("scope: r10 reads model-written framing only; a patient-written question with the same words composes unchanged", () => {
    for (const [field, question] of [
      ["en-intro", "Is this important and worth noting? Do I pay attention to the concerning ones?"],
      ["zh-intro", "这个值得关注吗？重要吗？我要留心什么？"],
    ] as const) {
      const base = R10_BASES[field];
      const original = fixtureRequest(base.fixture);
      const facts = original.facts.map((fact) => (fact.field === "QUESTION_TEXT" && fact.value.kind === "TEXT" ? { ...fact, value: { ...fact.value, text: question } } : fact));
      expect(facts.filter((fact) => fact.value.kind === "TEXT" && fact.value.text === question), question).toHaveLength(1);
      const request = { ...original, facts } as AiTaskRequest;
      expect(throughChain(request, envelope("DRAFT_CARE_PREPARATION_SUMMARY", base.locale, base.tokens, base.shells)), question).toEqual(ACCEPTED);
    }
  });

  it("English parity with r9: a descriptive phrase passes, a directive rejects", () => {
    expect(r10Probe("en-headline", "Here are the items you noted, {{S1}}.")).toEqual(ACCEPTED);
    expect(r10Probe("en-headline", "Please keep track of {{S1}}.")).toEqual(R9_S6_REJECTION);
  });
});

// --- Rules r11 (owner decision 2026-10-11, salience option (a)) ------------------------------------------------------------------
/**
 * Rules r11 (owner decision 2026-10-11, salience option (a)): model wording must not assign importance or noteworthiness to the person's
 * readings or patterns. Additive to r10 and read by S6 exactly as the r10 entries; model-written framing only. Every case runs through the
 * ACTUAL chain (r10Probe: the fixture's request → planSlots → validateShellCandidate → composeAiResult with verifyComposition) on the same
 * recorded ordinary bases as r10. The recorded FULL run stays FAIL: r11 rescores nothing.
 */
describe("shell rules r11: no salience words and no attention imperatives in model-written framing (actual chain)", () => {
  it("was labelled ai-shell-rules.11b.17-r11; r12 (additive) is the current label and every r11 case below still holds", () => {
    expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12");
  });

  // The owner's minimum negative list, each in the EXPLAIN headline it was written for.
  it.each<[R10Field, string]>([
    ["en-headline", "Here are the key items: {{S1}}."],
    ["en-headline", "A significant change: {{S1}}."],
    ["en-headline", "This is crucial: {{S1}}."],
    ["en-headline", "Look closely at {{S1}}."],
    ["en-headline", "Notice {{S1}}."],
    ["en-headline", "You may notice {{S1}}."],
    ["en-headline", "Keep in mind {{S1}}."],
    ["en-headline", "Here are the items to watch: {{S1}}."],
    ["zh-headline", "重点是{{S1}}。"],
    ["zh-headline", "关键内容：{{S1}}。"],
    ["zh-headline", "{{S1}}显著。"],
    ["zh-headline", "重點是{{S1}}。"],
    ["zh-headline", "關鍵內容：{{S1}}。"],
    ["zh-headline", "{{S1}}顯著。"],
  ])("r11 owner list: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // Variants read through the EXISTING scan copies (case and space folding, typographic quotes, the en pair joins of single words, the zh
  // ideograph gap and separator joins, the Traditional→Simplified copy with the additive r11 rows), close siblings and both field kinds.
  it.each<[R10Field, string]>([
    ["en-headline", "Here are the KEY items: {{S1}}."],
    ["en-headline", "Here are the key   items: {{S1}}."],
    ["en-headline", "Here are the ‘key’ items: {{S1}}."],
    ["en-headline", "Here are the key {{S1}}."],
    ["en-headline", "Here is what is key: {{S1}}."],
    ["en-headline", "Here is the key to {{S1}}."],
    ["en-headline", "Significantly, here is {{S1}}."],
    ["en-headline", "SIGNIFICANT: {{S1}}."],
    ["en-headline", "Here is a signi ficant look at {{S1}}."],
    ["en-headline", "Here is the significance of {{S1}}."],
    ["en-headline", "This is cru-cial: {{S1}}."],
    ["en-headline", "Crucially, here is {{S1}}."],
    ["en-headline", "Look very closely at {{S1}}."],
    ["en-headline", "Look at {{S1}} closely."],
    ["en-headline", "Look carefully at {{S1}}."],
    ["en-headline", "NOTICE {{S1}}."],
    ["en-headline", "No tice {{S1}}."],
    ["en-headline", "Here is {{S1}}; notice how it reads."],
    ["en-headline", "Here is {{S1}}, notice the pattern."],
    ["en-headline", "You will notice {{S1}}."],
    ["en-headline", "You’ll notice {{S1}}."],
    ["en-headline", "Here are the things to notice: {{S1}}."],
    ["en-headline", "Keep {{S1}} in mind."],
    ["en-headline", "KEEP   IN   MIND {{S1}}."],
    ["en-headline", "Bear in mind {{S1}}."],
    ["en-headline", "Something to keep in mind: {{S1}}."],
    ["en-headline", "Here is {{S1}} to watch."],
    ["en-headline", "Here are the items to monitor: {{S1}}."],
    ["en-intro", "These are the key readings."],
    ["en-intro", "These readings are significant."],
    ["en-intro", "Keep these readings in mind."],
    ["en-intro", "Here are the readings to watch."],
    ["zh-headline", "这里的重点是{{S1}}。"],
    ["zh-headline", "重 点是{{S1}}。"],
    ["zh-headline", "重、点是{{S1}}。"],
    ["zh-headline", "这里是关键的内容，{{S1}}。"],
    ["zh-headline", "这里是很关键的{{S1}}。"],
    ["zh-headline", "关 键内容：{{S1}}。"],
    ["zh-headline", "这里是显著的{{S1}}。"],
    ["zh-headline", "这里是显、著的{{S1}}。"],
    ["zh-headline", "{{S1}}很显著。"],
    ["zh-headline", "這裡的重點是{{S1}}。"],
    ["zh-headline", "這裡是關鍵的內容，{{S1}}。"],
    ["zh-headline", "這裡是顯著的{{S1}}。"],
    ["zh-intro", "以下是重点测量记录。"],
    ["zh-intro", "以下是关键的测量记录。"],
    ["zh-intro", "以下的测量记录很显著。"],
  ])("r11 variant: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // Not over-broad: the owner's benign descriptive forms, the person-described and non-evaluative uses the context checks keep open, and
  // the r10 approved forms (all still asserted in the r10 block above, which runs under r11).
  it.each<[R10Field, string]>([
    ["zh-headline", "这里呈现您所关注的{{S1}}。"],
    ["zh-headline", "这里呈现您所留意的{{S1}}。"],
    ["en-headline", "Here are the notes concerning {{S1}}."],
    ["en-headline", "Here are the items you noted, {{S1}}."],
    ["en-headline", "Here is a summary of the readings you selected: {{S1}}."],
    ["en-headline", "Here are the items you noticed: {{S1}}."],
    ["en-headline", "Here is the notice about {{S1}}."],
    ["en-headline", "Here are the readings you chose to watch: {{S1}}."],
    ["en-headline", "Here are the readings you wanted to monitor: {{S1}}."],
    ["en-headline", "Here are the items you marked as significant: {{S1}}."],
    ["en-headline", "Here are the entries you keyed in: {{S1}}."],
    ["en-headline", "Here are the keywords you used: {{S1}}."],
    ["en-headline", "Here is a low-key summary of {{S1}}."],
    ["en-headline", "Here are the items you kept in mind: {{S1}}."],
    ["en-headline", "Here are the items you keep in mind: {{S1}}."],
    ["en-headline", "Here is a closer look at {{S1}}."],
    ["en-headline", "Here is a look at what you tracked: {{S1}}."],
    ["en-headline", "Here is what the pattern looks at: {{S1}}."],
    ["en-intro", "Here is what you chose to note down."],
    ["zh-headline", "这里呈现您记录的关键词，{{S1}}。"],
    ["zh-headline", "這裡呈現您記錄的關鍵詞，{{S1}}。"],
    ["zh-headline", "这里呈现您认为关键的{{S1}}。"],
    ["zh-headline", "這裡呈現您認為關鍵的{{S1}}。"],
    ["zh-headline", "这里呈现您所标记为重点的{{S1}}。"],
    ["zh-headline", "这里呈现您认为重要的{{S1}}。"],
    ["zh-headline", "您的记录显示如下，{{S1}}。"],
    ["zh-headline", "這裡呈現您的記錄顯示的{{S1}}。"],
  ])("r11 accepted form: %s %j is accepted", (field, text) => {
    expect(r10Probe(field, text)).toEqual(ACCEPTED);
  });

  it("the recorded FULL outcomes are unchanged under r11: the ordinary bases and case 2 are accepted; cases 1, 3 and 4 reject as recorded", () => {
    for (const field of Object.keys(R10_BASES) as R10Field[]) {
      const base = R10_BASES[field];
      expect(r10Probe(field, "headline" in base.shells ? base.shells.headline : base.shells.sections[0]!.intro), field).toEqual(ACCEPTED);
    }
    expect(recordedExplain(R9_RECORDED.case2)).toEqual(ACCEPTED);
    expect(recordedExplain(R9_RECORDED.case1)).toEqual(R9_S6_REJECTION);
    expect(recordedExplain(R9_RECORDED.case3)).toEqual(R9_S6_REJECTION);
    const care = envelope("DRAFT_CARE_PREPARATION_SUMMARY", "en-SG", R9_CASE4.tokens, { sections: R9_CASE4.sections });
    expect(throughChain(fixtureRequest(R9_CASE4.fixture), care)).toEqual({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: ["DATE_OR_TIME"] });
  });

  it("scope: r11 reads model-written framing only; a patient-written question with the same words composes unchanged", () => {
    for (const [field, question] of [
      ["en-intro", "Is this key or significant? Is it crucial? Should I look closely, notice it and keep it in mind, and which ones to watch?"],
      ["zh-intro", "这是重点吗？关键吗？变化显著吗？"],
    ] as const) {
      const base = R10_BASES[field];
      const original = fixtureRequest(base.fixture);
      const facts = original.facts.map((fact) => (fact.field === "QUESTION_TEXT" && fact.value.kind === "TEXT" ? { ...fact, value: { ...fact.value, text: question } } : fact));
      expect(facts.filter((fact) => fact.value.kind === "TEXT" && fact.value.text === question), question).toHaveLength(1);
      const request = { ...original, facts } as AiTaskRequest;
      expect(throughChain(request, envelope("DRAFT_CARE_PREPARATION_SUMMARY", base.locale, base.tokens, base.shells)), question).toEqual(ACCEPTED);
    }
  });
});

// --- Rules r12 (owner decision 2026-10-11, policy-led prompt 11b.20) ---------------------------------------------------------------
/**
 * Rules r12 (owner decision 2026-10-11, with the policy-led prompt 11b.20: describe, never evaluate): four claim shapes, each a holder
 * and an assertion in the same clause, never a bare keyword — F1 a judgement of the person's data, F2 a benefit or cause of an activity
 * or treatment, F3 a completed-state claim, F4 an attributed feeling. Additive to r10/r11 and read by S6 exactly as their entries;
 * model-written framing only. Every case runs through the ACTUAL chain (r10Probe: the fixture's request → planSlots →
 * validateShellCandidate → composeAiResult with verifyComposition) on the same recorded ordinary bases, in both languages and in both
 * field kinds (the EXPLAIN headline and the first care intro). The recorded FULL run stays FAIL: r12 rescores nothing.
 */
const S5_FACT_REJECTION = (lexical: readonly string[]) => ({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical });
const S6_AUTHORITY_REJECTION = { kind: "REJECTED", gate: "S6", reason: "AUTHORITY_BOUNDARY_VIOLATION", repairable: false };
describe("shell rules r12: no judgement, benefit, completed-state or feeling claims in model-written framing (actual chain)", () => {
  it("is labelled ai-shell-rules.11b.18-r12", () => {
    expect(SHELL_RULES_REVISION).toBe("ai-shell-rules.11b.18-r12");
  });

  // The owner's must-reject list, in both field kinds. All reject at S6 under r12; the rows marked "existing" were already rejected before
  // r12 (the gate is unchanged) and are listed so the whole list stays pinned.
  it.each<[R10Field, string]>([
    // F1 judgement of the person's data.
    ["en-headline", "Well done, these results look good: {{S1}}."],
    ["en-intro", "Well done, these results look good."],
    ["en-headline", "Your levels are well controlled: {{S1}}."],
    ["en-intro", "Your levels are well controlled."],
    ["en-headline", "Here are the readings that stand out: {{S1}}."],
    ["en-intro", "Here are the readings that stand out."],
    ["en-headline", "Here are the readings that matter most: {{S1}}."],
    ["en-intro", "Here are the readings that matter most."],
    ["en-headline", "Here are noticeable readings: {{S1}}."],
    ["en-intro", "Here are noticeable readings."],
    ["en-headline", "Here are insignificant readings: {{S1}}."],
    ["en-intro", "Here are insignificant readings."],
    ["zh-headline", "以下是比较突出的记录，{{S1}}。"],
    ["zh-intro", "以下是比较突出的记录"],
    ["zh-headline", "以下是记录中的要点，{{S1}}。"],
    ["zh-intro", "以下是记录中的要点"],
    ["zh-headline", "这里呈现突出的内容，{{S1}}。"],
    ["zh-intro", "这里呈现突出的内容"],
    ["zh-headline", "这里呈现凸显的内容，{{S1}}。"],
    ["zh-intro", "这里呈现凸显的内容"],
    ["zh-headline", "您的结果很好，{{S1}}。"], // existing: the shared zh reassurance rule (结果 … 很好) already rejected it at S6
    ["zh-intro", "您的结果很好"], // existing (as above)
    // F2 benefit or cause.
    ["en-headline", "Great work, your walks are helping your health: {{S1}}."],
    ["en-intro", "Great work, your walks are helping your health."],
    ["en-headline", "Your medicine is working: {{S1}}."], // was S6b (clinical label "medicine") before r12; S6 runs first now
    ["en-intro", "Your medicine is working."],
    ["zh-headline", "散步对您的健康有帮助，{{S1}}。"],
    ["zh-intro", "散步对您的健康有帮助"],
    // F3 completed-state claim.
    ["en-headline", "These notes have been saved for you: {{S1}}."],
    ["en-intro", "These notes have been saved for you."],
    ["en-headline", "Your care team has these notes now: {{S1}}."],
    ["en-intro", "Your care team has these notes now."],
    ["en-headline", "These readings have been sent: {{S1}}."],
    ["en-intro", "These readings have been sent."],
    ["zh-headline", "这些记录已经保存好了，{{S1}}。"],
    ["zh-intro", "这些记录已经保存好了"],
    // F4 attributed feeling.
    ["en-headline", "You may be feeling worried about this: {{S1}}."],
    ["en-intro", "You may be feeling worried about this."],
    ["en-headline", "It is understandable to feel tired of keeping track: {{S1}}."],
    ["en-intro", "It is understandable to feel tired of keeping track."],
    ["zh-headline", "您可能会感到有些疲惫，{{S1}}。"],
    ["zh-intro", "您可能会感到有些疲惫"],
    ["zh-headline", "您可能觉得有点累，{{S1}}。"],
    ["zh-intro", "您可能觉得有点累"],
  ])("r12 owner list: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // Two owner-list rows were already rejected by an earlier gate, which r12 does not change (recorded, not weakened).
  it.each<[R10Field, string, unknown]>([
    ["zh-headline", "运动可以降低血糖，{{S1}}。", S5_FACT_REJECTION(["COMPARATIVE_DIRECTION", "MEASURE_NAME"])],
    ["zh-intro", "运动可以降低血糖", S5_FACT_REJECTION(["COMPARATIVE_DIRECTION", "MEASURE_NAME"])],
    ["zh-headline", "这些内容已发送给医生，{{S1}}。", S6_AUTHORITY_REJECTION],
    ["zh-intro", "这些内容已发送给医生", S6_AUTHORITY_REJECTION],
  ])("r12 owner list, earlier gate: %s %j keeps its earlier rejection", (field, text, expected) => {
    expect(r10Probe(field, text)).toEqual(expected);
  });

  // Variants read through the EXISTING scan copies (case and space folding, typographic quotes, the en pair joins, the zh ideograph gap and
  // separator joins, the Traditional→Simplified copy with the additive r12 rows) and close siblings of each frame, in both field kinds.
  it.each<[R10Field, string]>([
    ["en-headline", "THESE RESULTS LOOK GOOD: {{S1}}."],
    ["en-headline", "These  results   look   good: {{S1}}."],
    ["en-headline", "Here are the readings that stand-out: {{S1}}."],
    ["en-headline", "Here are the ‘noticeable’ readings: {{S1}}."],
    ["en-headline", "{{S1}} looks stable."],
    ["en-headline", "{{S1}} stands out."],
    ["en-headline", "Here is {{S1}}; it looks great."],
    ["en-headline", "Here is {{S1}}; they are on track."],
    ["en-intro", "These readings seem nicely balanced."],
    ["en-intro", "These numbers really matter."],
    ["zh-headline", "以下是比較突出的記錄，{{S1}}。"],
    ["zh-headline", "以下是比较 突出的记录，{{S1}}。"],
    ["zh-headline", "以下是比较、突出的记录，{{S1}}。"],
    ["zh-headline", "這裡呈現凸顯的內容，{{S1}}。"],
    ["zh-headline", "以下是記錄中的要點，{{S1}}。"],
    ["zh-headline", "这里呈现的{{S1}}很稳定。"],
    ["zh-headline", "这里呈现的{{S1}}比较突出。"],
    ["zh-headline", "这里呈现的{{S1}}很穩定。"],
    ["zh-intro", "以下是要点"],
    ["zh-intro", "这些记录都很稳定"],
    ["en-headline", "Your walks are HELPING your health: {{S1}}."],
    ["en-headline", "Your walks are help ing your health: {{S1}}."],
    ["en-headline", "Your workouts are helping: {{S1}}."],
    ["en-headline", "Exercise may benefit you: {{S1}}."],
    ["en-intro", "Walking is good for you."],
    ["en-intro", "Your meals are paying off."],
    ["zh-headline", "散步對您的健康有幫助，{{S1}}。"],
    ["zh-headline", "散 步对您有帮助，{{S1}}。"],
    ["zh-headline", "散步～对您有帮助，{{S1}}。"],
    ["zh-headline", "锻炼对您有帮助，{{S1}}。"],
    ["zh-intro", "运动对您很有益"],
    ["zh-intro", "鍛煉對您有幫助"],
    ["en-headline", "These notes have  been saved: {{S1}}."],
    ["en-headline", "THESE READINGS HAVE BEEN SENT: {{S1}}."],
    ["en-headline", "{{S1}} has been shared with your clinic."],
    ["en-intro", "Your notes are now saved."],
    ["en-intro", "Your doctor now has these notes."],
    ["zh-headline", "這些記錄已經保存好了，{{S1}}。"],
    ["zh-headline", "这些记录已 经保存，{{S1}}。"],
    ["zh-headline", "这些记录已经保～存好了，{{S1}}。"],
    ["zh-headline", "这里呈现的{{S1}}已经更新。"],
    ["zh-intro", "这些内容已为您保存"],
    ["zh-intro", "这些記錄已經上傳"],
    ["en-headline", "You may be FEELING worried: {{S1}}."],
    ["en-headline", "You might feel a bit tired: {{S1}}."],
    ["en-headline", "You seem worried about {{S1}}."],
    ["en-intro", "You might be tired of keeping track."],
    ["en-intro", "It is natural to feel overwhelmed."],
    ["zh-headline", "您可能會感到有些疲憊，{{S1}}。"],
    ["zh-headline", "您可能覺得有點累，{{S1}}。"],
    ["zh-headline", "您 可能 觉得 有点累，{{S1}}。"],
    ["zh-headline", "您可～能觉得有点累，{{S1}}。"],
    ["zh-intro", "您看起来有些疲惫"],
    ["zh-intro", "感到辛苦是可以理解的"],
  ])("r12 variant: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // Not over-broad: the owner's must-stay-accepted list (both field kinds), the phrasing the 11b.20 policy encourages, the r10 forms F4 must
  // not break, and descriptive neighbours of each frame (the person's own recording, choosing, marking and regarding; helping the person
  // prepare; "how it works"; a health record).
  it.each<[R10Field, string]>([
    // F1.
    ["en-headline", "Here is a look at {{S1}}."],
    ["en-intro", "Here is a look at what you chose to include."],
    ["en-headline", "Here is what the pattern looks at: {{S1}}."],
    ["en-intro", "Here is what the pattern looks at."],
    ["en-headline", "Here's a gentle look at {{S1}}."],
    ["en-intro", "Here's a gentle look at what you chose to include."],
    ["en-headline", "Here are the items you noticed: {{S1}}."],
    ["en-intro", "Here are the items you noticed."],
    ["en-headline", "Here are the readings you marked as noticeable, {{S1}}."],
    ["en-intro", "Here are the readings you marked as noticeable."],
    ["en-headline", "Here is a summary of the readings you selected: {{S1}}."],
    ["en-intro", "Here is a summary of the readings you selected."],
    ["zh-headline", "这里呈现您所留意的项目，{{S1}}。"],
    ["zh-intro", "这里呈现您所留意的项目"],
    ["zh-headline", "您想要点明的问题如下，{{S1}}。"],
    ["zh-intro", "您想要点明的问题如下"],
    ["zh-headline", "只要点开就能看到以下内容，{{S1}}。"],
    ["zh-intro", "只要点开就能看到以下内容"],
    ["zh-headline", "以下是主要记录，{{S1}}。"],
    ["zh-intro", "以下是主要记录"],
    ["zh-headline", "关键词如下，{{S1}}。"],
    ["zh-intro", "您记录的关键词如下"],
    // F2.
    ["en-headline", "This summary may help you prepare for your visit: {{S1}}."],
    ["en-intro", "This summary may help you prepare for your visit."],
    ["en-headline", "Here is what you chose to record: {{S1}}."],
    ["en-intro", "Here is what you chose to record."],
    ["zh-headline", "这份说明依据您记录下来的资料，{{S1}}。"],
    ["zh-intro", "这份说明依据您记录下来的资料"],
    // F3.
    ["en-headline", "Here are the readings you recorded: {{S1}}."],
    ["en-intro", "Here are the readings you recorded."],
    ["en-headline", "These come from what you wrote down: {{S1}}."],
    ["en-intro", "These come from what you wrote down."],
    ["en-headline", "Here is what you chose to note down: {{S1}}."],
    ["en-intro", "Here is what you chose to note down."],
    ["zh-headline", "这份说明依据您记录下来的{{S1}}。"],
    ["zh-intro", "这份说明依据您记录下来的内容"],
    ["zh-headline", "这些是您自己写下的内容，{{S1}}。"],
    ["zh-intro", "这些是您自己写下的内容"],
    // F4, and the r10 person-regarded forms it must not break.
    ["en-headline", "Thank you for preparing these questions: {{S1}}."],
    ["en-intro", "Thank you for preparing these questions."],
    ["en-headline", "Thanks for keeping these records: {{S1}}."],
    ["en-intro", "Thanks for keeping these records."],
    ["zh-headline", "感谢您整理这些内容，{{S1}}。"],
    ["zh-intro", "感谢您整理这些内容"],
    ["zh-headline", "谢谢您准备了这些想问的内容，{{S1}}。"],
    ["zh-intro", "谢谢您准备了这些想问的内容"],
    ["zh-headline", "这里呈现您认为重要的{{S1}}。"],
    ["zh-headline", "这里呈现您所觉得重要的{{S1}}。"],
    ["zh-headline", "这里呈现您觉得重要的{{S1}}。"],
    // Encouraged by the 11b.20 policy (no upstream/downstream contradiction).
    ["en-intro", "Here's what you chose to bring along."],
    ["en-headline", "This view comes from {{S1}}."],
    ["en-headline", "Thank you for recording this; here is {{S1}}."],
    ["zh-headline", "谢谢您的记录，这里呈现{{S1}}。"],
    ["zh-headline", "这份说明来自您记录下来的{{S1}}。"],
    ["zh-intro", "感谢您细心整理这些内容"],
    // Descriptive neighbours.
    ["en-headline", "Here is how it works: {{S1}}."],
    ["en-headline", "It may help you prepare to see these together: {{S1}}."],
    ["en-headline", "Here are the readings you have recorded: {{S1}}."],
    ["en-headline", "Here are the notes you shared: {{S1}}."],
    ["en-headline", "It is fine to bring these along: {{S1}}."],
    ["en-headline", "Here is what you recorded about your walks: {{S1}}."],
    ["en-headline", "Here is what you wrote about how you feel: {{S1}}."],
    ["en-intro", "Thank you for noting how you felt."],
    ["en-intro", "These notes may help you prepare for your visit."],
    ["zh-headline", "这份说明可以帮助您准备，{{S1}}。"],
    ["zh-headline", "这些内容有助于您回顾，{{S1}}。"],
    ["zh-headline", "这里呈现您已记录的内容，{{S1}}。"],
    ["zh-headline", "这里呈现您的健康记录，{{S1}}。"],
    ["zh-headline", "这里呈现您认为突出的{{S1}}。"],
    ["zh-headline", "这里呈现您写下的感受，{{S1}}。"],
    ["zh-intro", "这些是您记录的运动内容"],
    ["zh-intro", "这些问题有助于您沟通"],
  ])("r12 accepted form: %s %j is accepted", (field, text) => {
    expect(r10Probe(field, text)).toEqual(ACCEPTED);
  });

  it("the recorded FULL outcomes are unchanged under r12: the ordinary bases and case 2 are accepted; cases 1, 3 and 4 reject as recorded", () => {
    for (const field of Object.keys(R10_BASES) as R10Field[]) {
      const base = R10_BASES[field];
      expect(r10Probe(field, "headline" in base.shells ? base.shells.headline : base.shells.sections[0]!.intro), field).toEqual(ACCEPTED);
    }
    expect(recordedExplain(R9_RECORDED.case2)).toEqual(ACCEPTED);
    expect(recordedExplain(R9_RECORDED.case1)).toEqual(R9_S6_REJECTION);
    expect(recordedExplain(R9_RECORDED.case3)).toEqual(R9_S6_REJECTION);
    const care = envelope("DRAFT_CARE_PREPARATION_SUMMARY", "en-SG", R9_CASE4.tokens, { sections: R9_CASE4.sections });
    expect(throughChain(fixtureRequest(R9_CASE4.fixture), care)).toEqual({ kind: "REJECTED", gate: "S5", reason: "FACT_FIDELITY_FAILED", repairable: false, lexical: ["DATE_OR_TIME"] });
  });

  it("scope: r12 reads model-written framing only; a patient-written question with the same claims composes unchanged", () => {
    for (const [field, question] of [
      ["en-intro", "Is it well controlled? Are my walks helping? Has it been saved? I feel tired."],
      ["zh-intro", "结果很好吗？散步有帮助吗？已经保存了吗？我感到很累。"],
    ] as const) {
      const base = R10_BASES[field];
      const original = fixtureRequest(base.fixture);
      const facts = original.facts.map((fact) => (fact.field === "QUESTION_TEXT" && fact.value.kind === "TEXT" ? { ...fact, value: { ...fact.value, text: question } } : fact));
      expect(facts.filter((fact) => fact.value.kind === "TEXT" && fact.value.text === question), question).toHaveLength(1);
      const request = { ...original, facts } as AiTaskRequest;
      const candidate = envelope("DRAFT_CARE_PREPARATION_SUMMARY", base.locale, base.tokens, base.shells);
      expect(throughChain(request, candidate), question).toEqual(ACCEPTED);
      // Fix round 1 (M4): the patient text is present verbatim in the composed output (self-proving scope).
      expect(JSON.stringify(composedThroughChain(request, candidate)), question).toContain(question);
    }
  });
});

/** The full chain, returning the composition itself (r12 fix round 1, for the verbatim scope check). */
function composedThroughChain(request: AiTaskRequest, candidate: Record<string, unknown>): unknown {
  const taskBundle = AI_HYBRID_RUNTIME_BUNDLES[request.taskType as "EXPLAIN_PATTERN"];
  const planned = planSlots(request, taskBundle);
  if (planned.kind !== "PLANNED") throw new Error(`unplannable ${request.requestId}`);
  const validated = validateShellCandidate(planned.plan, taskBundle, JSON.stringify(candidate));
  if (validated.kind === "REJECTED") throw new Error(`rejected ${validated.gate}`);
  const composed = composeAiResult(request, planned.plan, planned.atoms, validated.shells, taskBundle, { verify: verifyComposition });
  if (composed.kind === "REJECTED") throw new Error("composition rejected");
  return composed;
}

/** One r12 probe of the EXPLAIN evidence field (fix round 1, M3): the recorded ordinary EXPLAIN base with its evidence replaced. */
function r12EvidenceProbe(locale: "en-SG" | "zh-SG", evidence: string) {
  const base = R10_BASES[locale === "en-SG" ? "en-headline" : "zh-headline"];
  return throughChain(fixtureRequest(base.fixture), envelope("EXPLAIN_PATTERN", base.locale, base.tokens, { headline: base.shells.headline, evidence }));
}

// --- Rules r12 fix round 1 (independent review I1/I2/M3) ---------------------------------------------------------------------------
/**
 * Fix round 1: the F2 holder is narrowed to an activity or treatment ("this", "it", 这 and the slot stand-in no longer hold a benefit
 * claim); the zh frames read clause-preserving copies (no holder/assertion pairing across ，。；！？、 or a line break); the zh F3 exemption
 * reads the person's own earlier action with up to two time or manner adverbs (您之前已经保存的); the zh attributive F1 needs 的 or the noun
 * directly (稳定地记录 stays open); and the plain forms the four shapes intend are added inside the same frames. Actual chain throughout.
 */
describe("shell rules r12 fix round 1: encouraged wording stays open, plain forms of the four shapes reject (actual chain)", () => {
  it.each<[R10Field, string]>([
    // I1(a): the person's own earlier action (F3 exemption window).
    ["zh-intro", "感谢您之前已经保存的记录"],
    ["zh-intro", "这些是您之前已分享的提问"],
    ["zh-intro", "这些是您刚才已经更新的内容"],
    ["zh-intro", "这是您先前已更新的内容"],
    // I1(b): a summary or demonstrative helping the person prepare or understand is not a benefit claim (F2 holder narrowed).
    ["en-intro", "This may help you get ready for your visit."],
    ["en-headline", "This may help you understand {{S1}}."],
    ["en-headline", "This helps you revisit {{S1}}."],
    ["en-intro", "This can be useful for your visit."],
    ["en-intro", "Thank you; it helps to keep these together."],
    ["zh-intro", "这样可以帮助您做好准备"],
    ["zh-headline", "这有助于您了解{{S1}}。"],
    ["zh-intro", "这可以帮助您回想想问的内容"],
    // I1(c): the adverbial 稳定地 + a verb is not a judgement of data.
    ["zh-intro", "谢谢您一直以来稳定地记录"],
    // I1(d): no pairing across a clause boundary.
    ["zh-headline", "这里呈现{{S1}}，可以帮助您回想。"],
    ["zh-intro", "您的饮食记录在这里，有助于您和医生交流"],
    ["zh-intro", "这里整理了您的饮食记录，可以帮助您在就诊时说明"],
    // The person as subject of the active perfect stays open (I2 F3).
    ["en-intro", "Here are the notes you have saved."],
    ["en-intro", "Here is what you've recorded."],
    // F4 must not break r10 or the encouraged thanks.
    ["zh-headline", "这里呈现您认为重要的{{S1}}。"],
    ["zh-headline", "这里呈现您所觉得重要的{{S1}}。"],
    ["en-intro", "Thank you for preparing these questions."],
    ["zh-intro", "感谢您整理这些内容"],
  ])("r12 fix round 1 accepted form: %s %j is accepted", (field, text) => {
    expect(r10Probe(field, text)).toEqual(ACCEPTED);
  });

  it.each<[R10Field, string]>([
    // I2 F3: the active perfect with the app, JagaOn, "we" or a third party as subject; zh parity.
    ["en-intro", "We have saved these notes for you."],
    ["en-intro", "The app has saved these notes."],
    ["en-intro", "JagaOn has updated your notes."],
    ["en-intro", "We've sent these to your care team."],
    ["en-headline", "We have saved {{S1}} for you."],
    ["zh-intro", "系统已保存这些记录"],
    ["zh-intro", "您的记录已经保存好了"],
    // I2 F1.
    ["en-intro", "Your readings are looking good."],
    ["en-intro", "Your readings have been steady."],
    ["en-intro", "Everything looks good here."],
    ["en-intro", "All of this looks good."],
    ["en-intro", "The readings you recorded look good."],
    ["en-headline", "Your readings have been steady: {{S1}}."],
    ["zh-intro", "这些读数控制良好"],
    ["zh-intro", "这些读数表现良好"],
    ["zh-intro", "这些数值令人满意"],
    ["zh-headline", "这些读数控制良好，{{S1}}。"],
    // I2 F2.
    ["en-intro", "Walking regularly helps."],
    ["en-intro", "Your diet has made a difference."],
    ["zh-intro", "坚持运动效果很好"],
    ["zh-headline", "坚持运动效果很好，{{S1}}。"],
    // I2 F4.
    ["zh-intro", "您一定很担心"],
    ["zh-intro", "您可能有些担心"],
    ["zh-intro", "这段时间您辛苦了"],
    ["zh-headline", "您一定很担心，这里呈现{{S1}}。"],
    // Same-clause rejections stay rejected; F2 with an activity holder still rejects.
    ["zh-intro", "以下是比较突出的记录"],
    ["zh-intro", "散步对您很有帮助"],
    ["zh-intro", "这些读数很稳定"],
    ["en-intro", "Your walks are helping your health."],
    // Traditional, spacing and non-boundary punctuation variants of the added forms.
    ["zh-intro", "這些讀數控制良好"],
    ["zh-intro", "您一定很擔心"],
    ["zh-intro", "堅持運動 效果很好"],
    ["zh-intro", "这些数值令人满～意"],
  ])("r12 fix round 1 rejected form: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });

  // M3: the EXPLAIN evidence field goes through the same S6 path.
  it.each<["en-SG" | "zh-SG", string, unknown]>([
    ["en-SG", "This explanation draws on {{S3}}.", ACCEPTED],
    ["en-SG", "This draws on {{S3}}, which has been reviewed.", R9_S6_REJECTION],
    ["en-SG", "These results look good: {{S3}}.", R9_S6_REJECTION],
    ["en-SG", "This may help you understand {{S3}}.", ACCEPTED],
    ["en-SG", "We have updated {{S3}} for you.", R9_S6_REJECTION],
    ["zh-SG", "这份说明依据{{S3}}来整理。", ACCEPTED],
    ["zh-SG", "这份说明依据您之前已分享的{{S3}}。", ACCEPTED],
    ["zh-SG", "这份说明依据您已分享的{{S3}}。", ACCEPTED],
    ["zh-SG", "这份说明依据{{S3}}，这些读数很稳定。", R9_S6_REJECTION],
    ["zh-SG", "这份说明依据{{S3}}，散步对您很有帮助。", R9_S6_REJECTION],
    ["zh-SG", "这份说明依据{{S3}}，您可能会感到疲惫。", R9_S6_REJECTION],
  ])("r12 evidence field: %s %j", (locale, evidence, expected) => {
    expect(r12EvidenceProbe(locale, evidence)).toEqual(expected);
  });
});

// --- Rules r12 fix round 2 (coordinator: F2 regression, clause-mark split) ---------------------------------------------------------
/**
 * Fix round 2: the narrowed F2 activity/treatment holder stays, and a holder-independent benefit shape is added — a benefit verb whose
 * object or complement is a health, body or reading target (helps your health, good for your health, 对您的健康有帮助, 有助于控制血糖), and an
 * intransitive "is helping"/"is working" closing a clause with a data, slot or demonstrative subject ({{S1}} is helping., 该项对您有帮助).
 * "help you get ready / understand / revisit …" has no such target and stays open. A single 、 or ， between the two characters of an r12
 * cue bigram (已、经, 已，经) is read as a split inside one word; every other clause mark keeps its boundary. Actual chain throughout.
 */
describe("shell rules r12 fix round 2: holder-independent benefit claims and in-word clause-mark splits (actual chain)", () => {
  it.each<[R10Field, string, unknown]>([
    ["en-intro", "It helps your health.", R9_S6_REJECTION],
    ["en-intro", "This helps your sugar.", R9_S6_REJECTION],
    ["en-headline", "{{S1}} is helping.", R9_S6_REJECTION],
    ["en-headline", "{{S1}} is helping your health.", R9_S6_REJECTION],
    ["en-intro", "This is good for your health.", R9_S6_REJECTION],
    ["en-intro", "This helps you control your levels.", R9_S6_REJECTION],
    ["en-intro", "It is working.", R9_S6_REJECTION],
    ["zh-intro", "这对您的健康有帮助", R9_S6_REJECTION],
    ["zh-headline", "该项对您有帮助，{{S1}}。", R9_S6_REJECTION],
    ["zh-headline", "{{S1}}对您有帮助。", R9_S6_REJECTION],
    ["zh-intro", "它对您很有帮助", R9_S6_REJECTION],
    ["zh-intro", "这样很有帮助。", R9_S6_REJECTION],
    // An earlier gate already rejects this one (血糖 is a measurement name at S5); recorded, unchanged.
    ["zh-intro", "它有助于控制血糖", S5_FACT_REJECTION(["MEASURE_NAME"])],
    // In-word clause-mark splits of a cue word reject like the unsplit word (Simplified and Traditional).
    ["zh-intro", "这些记录已、经保存", R9_S6_REJECTION],
    ["zh-intro", "这些内容已，经发送", R9_S6_REJECTION],
    ["zh-headline", "这些记录已、经保存，{{S1}}。", R9_S6_REJECTION],
    ["zh-intro", "這些記錄已、經保存", R9_S6_REJECTION],
    ["zh-intro", "以下是比较突、出的记录", R9_S6_REJECTION],
  ])("r12 fix round 2 rejected form: %s %j", (field, text, expected) => {
    expect(r10Probe(field, text)).toEqual(expected);
  });

  it.each<[R10Field, string]>([
    ["en-intro", "This may help you get ready for your visit."],
    ["en-headline", "This may help you understand {{S1}}."],
    ["en-headline", "This helps you revisit {{S1}}."],
    ["en-intro", "This summary may help you prepare for your visit."],
    ["en-intro", "This may help you check what you wanted to ask."],
    ["en-intro", "Thank you; it helps to keep these together."],
    ["en-headline", "Here is how it works: {{S1}}."],
    ["en-intro", "Here are your notes about your health."],
    ["zh-intro", "这样可以帮助您做好准备"],
    ["zh-headline", "这有助于您了解{{S1}}。"],
    ["zh-intro", "这可以帮助您回想想问的内容"],
    ["zh-headline", "这里呈现{{S1}}，可以帮助您回想。"],
    ["zh-intro", "您的饮食记录在这里，有助于您和医生交流"],
    ["zh-intro", "这里整理了您的饮食记录，可以帮助您在就诊时说明"],
    ["zh-intro", "这里整理了您的健康记录"],
    ["zh-intro", "这里是您的记录，好好回顾一下"],
    ["zh-intro", "感谢您之前已经保存的记录"],
  ])("r12 fix round 2 accepted form: %s %j is accepted", (field, text) => {
    expect(r10Probe(field, text)).toEqual(ACCEPTED);
  });

  it("evidence field: a holder-independent benefit claim rejects; provenance stays open", () => {
    expect(r12EvidenceProbe("en-SG", "This draws on {{S3}}, which helps your health.")).toEqual(R9_S6_REJECTION);
    expect(r12EvidenceProbe("en-SG", "This may help you understand {{S3}}.")).toEqual(ACCEPTED);
    expect(r12EvidenceProbe("zh-SG", "这份说明依据{{S3}}，对您的健康有帮助。")).toEqual(R9_S6_REJECTION);
    expect(r12EvidenceProbe("zh-SG", "这份说明依据您之前已分享的{{S3}}。")).toEqual(ACCEPTED);
  });
});

// --- Rules r12 fix round 3 (owner option (a) for re-review IMP-1) -----------------------------------------------------------------
/**
 * Fix round 3: the round-2 cue-bigram join is replaced. A single 、/， is rebuilt as part of a word ONLY when it sits strictly inside one word
 * of the closed, reviewed r12 cue-word list (SHELL_R12_SPLIT_CUE_WORDS), so the two halves rebuild exactly that word; a mark after a
 * complete word (整理，想…, 都有，帮助…, 而已，经…) stays a clause boundary. The owner's required rows run through the actual chain.
 */
describe("shell rules r12 fix round 3: clause marks are rebuilt only inside listed cue words (actual chain)", () => {
  it("the cue-word join rebuilds only an in-word split of a listed cue word and keeps every other clause mark", () => {
    expect(r12CueWordJoined("这些记录已、经保存好了")).toBe("这些记录已经保存好了");
    expect(r12CueWordJoined("散步对您的健康有，帮助")).toBe("散步对您的健康有帮助");
    expect(r12CueWordJoined("读数很稳，定")).toBe("读数很稳定");
    expect(r12CueWordJoined("以下内容依据您的记录整理，想问的问题也一并列出")).toBe("以下内容依据您的记录整理，想问的问题也一并列出");
    expect(r12CueWordJoined("您的散步和饮食记录都有，帮助您回想")).toBe("您的散步和饮食记录都有，帮助您回想");
    expect(r12CueWordJoined("这些内容只是整理而已，经您确认后可带去")).toBe("这些内容只是整理而已，经您确认后可带去");
    expect(r12CueWordJoined("这里呈现该项，可以帮助您回想")).toBe("这里呈现该项，可以帮助您回想");
    expect(SHELL_R12_SPLIT_CUE_WORDS).toEqual(["已经", "保存", "发送", "提交", "分享", "突出", "凸显", "稳定", "平稳", "良好", "满意", "有帮助", "有助于", "帮助", "健康", "感到", "觉得", "可能", "疲惫", "担心", "辛苦"]);
  });

  it.each<[R10Field, string]>([
    // The seven IMP-1 sentences (re-review): ordinary two-clause wording.
    ["zh-intro", "以下内容依据您的记录整理，想问的问题也一并列出"],
    ["zh-intro", "这些问题已为您整理，想问的内容如下"],
    ["zh-intro", "这些内容已为您整理，想带去的问题也在这里"],
    ["zh-intro", "您的记录已整理，想问的问题在下方"],
    ["zh-intro", "这些记录由您自己管理，想带去的都在这里"],
    ["zh-intro", "您的散步和饮食记录都有，帮助您回想"],
    ["zh-intro", "您的运动记录都有，帮助您了解这段时间"],
    // The person's own saved or shared records, also with a 、/， inside 已经 (owner addendum).
    ["zh-intro", "感谢您之前已经保存的记录"],
    ["zh-intro", "这些是您之前已分享的提问"],
    ["zh-intro", "感谢您之前已、经保存的记录"],
    ["zh-intro", "这些是您之前已，经分享的提问"],
    // Earlier harmless two-clause and enumeration cases.
    ["zh-headline", "这里呈现{{S1}}，可以帮助您回想。"],
    ["zh-intro", "您的饮食记录在这里，有助于您和医生交流"],
    ["zh-intro", "这些内容只是整理而已，经您确认后可带去"],
    ["zh-intro", "这里方便您就诊，所有记录都在下方"],
    ["zh-intro", "这些内容方便您核对，您的健康记录也在其中"],
    ["zh-intro", "这些内容为您呈现，在就诊时方便查看"],
    ["zh-intro", "您记录了工作、用餐和散步的时间"],
    ["zh-intro", "这里呈现您的记录，已为您按顺序排列"],
    ["zh-intro", "这里是您的记录，保存在您的日志中"],
    ["zh-intro", "您写下的问题都在这里，一定能找到"],
    ["zh-intro", "这些内容来自您，觉得有用就带上"],
    ["zh-intro", "这些记录您都看过，辛苦记录的内容如下"],
    ["zh-intro", "这里列出散步、运动和饮食的记录"],
  ])("r12 fix round 3 accepted form: %s %j is accepted", (field, text) => {
    expect(r10Probe(field, text)).toEqual(ACCEPTED);
  });

  it("the 已，经 split before 发送给医生 rejects at S6 through the shared authority rule (already 已经发送给 on the joined copy)", () => {
    expect(r10Probe("zh-intro", "这些内容已，经发送给医生")).toEqual(S6_AUTHORITY_REJECTION);
  });

  it("evidence field: the person's own earlier shared records stay open, also split inside 已经", () => {
    expect(r12EvidenceProbe("zh-SG", "这份说明依据您之前已分享的{{S3}}。")).toEqual(ACCEPTED);
    expect(r12EvidenceProbe("zh-SG", "这份说明依据您之前已、经分享的{{S3}}。")).toEqual(ACCEPTED);
    expect(r12EvidenceProbe("zh-SG", "这份说明依据{{S3}}，已、经保存好了。")).toEqual(R9_S6_REJECTION);
  });

  it.each<[R10Field, string]>([
    ["zh-intro", "这些记录已、经保存好了"],
    ["zh-intro", "系统已、经保存这些记录"],
    ["zh-headline", "这里呈现突、出的内容，{{S1}}。"],
    ["zh-intro", "读数很稳，定"],
    ["zh-intro", "您可能感、到有些疲惫"],
    ["zh-intro", "散步对您的健康有，帮助"],
    ["zh-intro", "散步对您的健、康有帮助"],
    ["zh-intro", "您可、能觉得有点累"],
    ["zh-intro", "数值令人满、意"],
    ["zh-intro", "读数控制良、好"],
    ["zh-intro", "這些記錄已、經保存好了"],
    ["zh-intro", "以下是比較突、出的記錄"],
    ["zh-intro", "读数很穩，定"],
    ["zh-intro", "散步對您的健康有，幫助"],
  ])("r12 fix round 3 rejected form: %s %j rejects at S6", (field, text) => {
    expect(r10Probe(field, text)).toEqual(R9_S6_REJECTION);
  });
});
