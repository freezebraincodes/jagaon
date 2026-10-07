import { parseStrictJson, StrictJsonError, toPlainData } from "@/backup/strict-json";
import { BARE_SLOT_ID, remoteFields, remoteTokenInventory, shellOutputSchema, slotTokenMatcher, type AiLocale, type ShellFieldPath, type ShellFieldSpec, type ShellTexts, type SlotId, type SlotPlan } from "@/domain/ai";
import type { AiHybridRuntimeBundle } from "../ai-hybrid-runtime-bundles";
import { MEANING_RULES, meaningScanText } from "../ai-meaning-rules";
import { localeTextAccepted } from "../ai-output-validator";
import { AI_LANGUAGE_COPY, type LanguageCopy } from "./ai-language-copy";
import { CLINICAL_TOKEN_SEPARATOR, foldShellScanText, provenanceSafeMatch, SHELL_DIRECTIVE_PATTERNS, shellClinicalLabel, shellDirectiveScanTexts, shellLexicalViolations, shellRegisterViolation, shellScanCopies, standInOccurrence, standInShadow, tokenSeparatedScanText, type ShellClinicalLabelCategory, type ShellLexicalViolation, type ShellRegisterCode, type StandInOccurrence } from "./shell-lexicon";

/**
 * Packet 11B.6 shell validator, gates S1–S7 (spec Section 8.1). Applied before any atom is inserted. Only
 * S1/S2 structural failures are repairable, and only under the bundle; every other rejection is final and
 * falls back to the deterministic composition.
 * Rules r2 (Packet 11B.7 hardening): S3 is exact per field (the found token sequence equals requiredSlots, order
 * included) and first checks the echoed slot plan version and token inventory; an S3 rejection carries an
 * evaluation-only `integrity` sub-code (the audit reason stays REFERENCE_MISMATCH). S4b requires language
 * outside the tokens. S5, S6 and S7 read the folded scan copy; the returned shell texts are the originals.
 * Fix round 1: S4b counts only allowlisted letters on the scan copy, S5 adds the locale allowlist
 * (DISALLOWED_CHARACTER), and S7 checks both the original text and the scan copy.
 * Fix round 2: S5, S6 and S7 read the locale scan copy (zh-SG removes whitespace between two CJK ideographs).
 * Fix round 3: S5 also checks the original text against the allowlist (plus fold sources), and for zh-SG the S5
 * word-list rules and S6 also read the joined copy (punctuation, symbols and whitespace between ideographs removed).
 * Rules r4 (ai-shell-rules.11b.11-r4, wording quality): the new gate S7b requires meaningful wording (`meaningfulWording`)
 * in every EXPLAIN field (headline, observation, evidence) and in every care section intro; a care bullet may still be fact
 * only, and words in a bullet never rescue its section's intro. Reason OUTPUT_BUDGET_EXCEEDED, never repairable, with the
 * evaluation-only `quality` detail (NOT_MEANINGFUL and the failing field kind). S4b keeps the r2 presence check before S5;
 * S7b runs after S7 (fix round 1, controller ruling: its own label, so gate labels follow execution order), so the stricter
 * wording rule never masks a fact, meaning or authority rejection (S5/S6, evaluation hard gates) or a locale rejection
 * (S7) that the same text would get. S7 adds the zh-SG register rule (no 你/妳 in the model wording): LOCALE_INVALID with
 * the evaluation-only `register` detail.
 * Rules r5 (ai-shell-rules.11b.12-r5, clinical labels, owner instruction 2026-10-06): the new gate S6b, after S5 and S6 (so the
 * r2–r4 folding, fact and meaning gates keep their attribution) and before S7, rejects model wording that names a disease or
 * condition, diagnosis, symptom, medication, treatment or other clinical label (`shellClinicalLabel`, every scan copy, tokens
 * removed so atoms are never scanned). Reason CLINICAL_MEANING_VIOLATION, never repairable, with the evaluation-only
 * `clinicalLabel` detail (the category); the first failing field in plan order decides.
 * Rules r6 (ai-shell-rules.11b.13-r6, owner instruction 2026-10-06): S6b keeps its position, reason, non-repairability and
 * category detail; only its matcher changes (complete en words and listed inflections, exact split reconstructions, deliberate
 * zh forms, closed neutral logistics phrases masked first; see shell-lexicon.ts).
 * Rules r8 (ai-shell-rules.11b.15-r8, owner instruction 2026-10-07): S6 keeps its position, reasons (AUTHORITY_BOUNDARY_VIOLATION
 * before CLINICAL_MEANING_VIOLATION), non-repairability and its unchanged rules (the shared meaning rules and the directive lists);
 * only its reading changes (`shellMeaningScan`): a match that splits a stand-in occurrence no longer counts, and a token-separated
 * copy is read as well. S5, S6b, S7 and S7b are unchanged.
 * Observation ownership (validator profile 11b.18, owner instruction 2026-10-07): the gates check only the plan's REMOTE fields — the
 * model's fields. The EXPLAIN shells are { headline, evidence } (an observation key is S2 SCHEMA_INVALID); S3 compares the echo with
 * the remote token inventory and closes each remote field; S4–S7b read the remote fields; the S4b presence groups and the S7b paths
 * for EXPLAIN are the headline and the evidence. No rule or word list changed, and an application-owned field's tokens never count as
 * missing. The VALID result carries the remote field texts only; the application composes the rest (ai-composition.ts).
 */
export type ShellGate = "S1" | "S2" | "S2a" | "S3" | "S4" | "S4b" | "S5" | "S6" | "S6b" | "S7" | "S7b";
/** The shell gates in execution order (the assembler S9 and the verifier S10 follow). */
export const SHELL_GATE_ORDER: readonly ShellGate[] = Object.freeze(["S1", "S2", "S2a", "S3", "S4", "S4b", "S5", "S6", "S6b", "S7", "S7b"]);
/** Rules r4, evaluation only: why S7b rejected — never written to the audit row. */
export type ShellWordingFieldKind = "headline" | "observation" | "evidence" | "intro";
export type ShellQualityDetail = Readonly<{ code: "NOT_MEANINGFUL"; fieldKind: ShellWordingFieldKind }>;
export type ShellValidationReason = "SCHEMA_INVALID" | "LOCALE_INVALID" | "MODEL_ABSTAINED" | "REFERENCE_MISMATCH" | "OUTPUT_BUDGET_EXCEEDED" | "FACT_FIDELITY_FAILED" | "CLINICAL_MEANING_VIOLATION" | "AUTHORITY_BOUNDARY_VIOLATION";
/** Why S3 rejected, for evaluation only; never written to the audit row. */
export type ShellIntegrityCode = "TOKEN_MALFORMED" | "TOKEN_STRAY" | "TOKEN_DUPLICATE" | "TOKEN_MISSING" | "TOKEN_REORDERED" | "INVENTORY_MISMATCH";
export type { ShellClinicalLabelCategory, ShellRegisterCode };
export type ShellValidationResult =
  | Readonly<{ kind: "VALID"; shells: ShellTexts }>
  | Readonly<{ kind: "REJECTED"; gate: ShellGate; reason: ShellValidationReason; repairable: boolean; lexical?: readonly ShellLexicalViolation[]; integrity?: ShellIntegrityCode; register?: ShellRegisterCode; quality?: ShellQualityDetail; clinicalLabel?: ShellClinicalLabelCategory }>;

const LOOK_ALIKE = /[{}]|\[\[|\]\]|⟦|⟧/;
export const stripSlotTokens = (text: string, replacement: string): string => text.replace(slotTokenMatcher(), replacement);
const CJK_IDEOGRAPH = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const ASCII_LETTER = /[A-Za-z]/;

/**
 * S4b presence (r2): the folded scan copy of the text outside the tokens holds an allowlisted letter — an ASCII letter
 * (en-SG) or a CJK ideograph (zh-SG). Fix round 1: fillers, homoglyphs and other scripts never count as language.
 * Rules r4: S4b is unchanged (before S5); the meaningful-wording rule (`meaningfulWording`) is gate S7b, after S7.
 */
export function languagePresent(text: string, locale: AiLocale): boolean {
  return (locale === "zh-SG" ? CJK_IDEOGRAPH : ASCII_LETTER).test(foldShellScanText(stripSlotTokens(text, " ")));
}

/** Rules r4: the closed en filler and interjection words that never count as meaningful wording (exact, case-insensitive). */
const EN_FILLER_WORDS: ReadonlySet<string> = new Set(["ok", "okay", "oh", "hey", "um", "uh", "hmm", "well", "so", "just", "yeah", "yes", "no"]);
/**
 * Rules r4: the closed zh filler list removed before counting ideographs — the reduplicated 看看 瞧瞧 说说 想想, 一下, and the
 * particles 吧 呢 啊 哦 嗯 呀 啦 嘛. A fresh global matcher per call, so no lastIndex state is shared.
 */
const zhFiller = (): RegExp => /看看|瞧瞧|说说|想想|一下|[吧呢啊哦嗯呀啦嘛]/gu;
const cjkIdeographs = (): RegExp => /[\u3400-\u9FFF\uF900-\uFAFF]/gu;
/**
 * Rules r4 thresholds, in DISTINCT units (fix round 2): en-SG at least two different non-filler words of two or more ASCII
 * letters (case-insensitive); zh-SG at least five different ideographs after filler removal.
 */
export const MEANINGFUL_WORDING_MINIMUM: Readonly<Record<AiLocale, number>> = Object.freeze({ "en-SG": 2, "zh-SG": 5 });

/**
 * Rules r4 (S7b): the model wording outside the slot tokens is a meaningful phrase. Tokens are removed (never replaced by
 * the stand-in), so no atom or value is ever counted or required.
 * en-SG: on the folded scan copy, at least two DISTINCT words (maximal runs of ASCII letters, compared case-insensitively)
 * of two or more letters that are not in the closed filler list. zh-SG: at least five DISTINCT CJK ideographs after removing
 * the closed filler list, on EVERY zh scan copy (folded, joined, look-alike and their Traditional→Simplified copies; the
 * smallest count decides, so 說說 is filler too). Fix round 2: repeats count once ("这这这这这", "The the" fail). Two
 * distinct non-words ("Aa bb") still pass: a known design limit (no dictionary).
 * Values, units, dates, counts, medical terms, references or advice are never required.
 */
export function meaningfulWording(text: string, locale: AiLocale): boolean {
  const residue = stripSlotTokens(text, " ");
  if (locale === "en-SG") {
    const words = foldShellScanText(residue, locale).match(/[A-Za-z]+/g) ?? [];
    const distinct = new Set(words.map((word) => word.toLowerCase()).filter((word) => word.length >= 2 && !EN_FILLER_WORDS.has(word)));
    return distinct.size >= MEANINGFUL_WORDING_MINIMUM[locale];
  }
  const counts = shellScanCopies(residue, locale).map((copy) => new Set(copy.replace(zhFiller(), " ").match(cjkIdeographs()) ?? []).size);
  return Math.min(...counts) >= MEANINGFUL_WORDING_MINIMUM[locale];
}

/**
 * Rules r4: the fields that must carry meaningful wording — every model-written EXPLAIN field (11b.18: the headline and the
 * evidence; the observation is application-owned) and every care section intro (never a bullet).
 */
export function meaningfulWordingPaths(plan: SlotPlan): readonly ShellFieldPath[] {
  return plan.taskType === "EXPLAIN_PATTERN" ? ["headline", "evidence"] : plan.sections.map((section) => section.introPath);
}

/** S3 for one field, in a fixed order: malformed, stray, duplicate, missing, reordered. */
function tokenIntegrity(field: ShellFieldSpec, text: string): ShellIntegrityCode | null {
  const residue = stripSlotTokens(text, " ");
  if ([residue, foldShellScanText(residue)].some((entry) => LOOK_ALIKE.test(entry) || BARE_SLOT_ID.test(entry))) return "TOKEN_MALFORMED";
  const found = [...text.matchAll(slotTokenMatcher())].map((match) => match[1] as SlotId);
  if (found.some((slot) => !field.requiredSlots.includes(slot))) return "TOKEN_STRAY";
  if (new Set(found).size !== found.length) return "TOKEN_DUPLICATE";
  if (found.length !== field.requiredSlots.length) return "TOKEN_MISSING";
  if (found.join("|") !== field.requiredSlots.join("|")) return "TOKEN_REORDERED";
  return null;
}
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const terminals = (trimmed.match(/[.!?。！？]+/g) ?? []).length;
  return terminals === 0 ? 1 : terminals + (/[.!?。！？]$/.test(trimmed) ? 0 : 1);
}

function flatten(plan: SlotPlan, shells: unknown): Map<ShellFieldPath, string> | null {
  const texts = new Map<ShellFieldPath, string>();
  if (plan.taskType === "EXPLAIN_PATTERN") {
    const explain = shells as { headline: string; evidence: string };
    texts.set("headline", explain.headline).set("evidence", explain.evidence);
    return texts;
  }
  const care = shells as { sections: Array<{ sectionSlot: string; intro: string; bullets: string[] }> };
  if (care.sections.length !== plan.sections.length) return null;
  for (const [index, section] of plan.sections.entries()) {
    const supplied = care.sections[index]!;
    if (supplied.sectionSlot !== section.sectionSlot || supplied.bullets.length !== section.bulletPaths.length) return null;
    texts.set(section.introPath, supplied.intro);
    section.bulletPaths.forEach((path, position) => texts.set(path, supplied.bullets[position]!));
  }
  return texts;
}

/** Rules r8: what S6 found in one field (the authority and clinical meaning rules and the directive lists). */
export type ShellMeaningScan = Readonly<{ authority: boolean; clinical: boolean; directive: boolean }>;
type S6Role = "AUTHORITY" | "CLINICAL" | "DIRECTIVE";
/** The unchanged S6 rules by role: the shared meaning rules (authority read on the copy, clinical on its meaning scan text) and the directives. */
const S6_PATTERNS: Readonly<Record<S6Role, readonly RegExp[]>> = Object.freeze({
  AUTHORITY: Object.freeze(MEANING_RULES.filter((rule) => rule.kind === "AUTHORITY").map((rule) => rule.pattern)),
  CLINICAL: Object.freeze(MEANING_RULES.filter((rule) => rule.kind === "CLINICAL").map((rule) => rule.pattern)),
  DIRECTIVE: SHELL_DIRECTIVE_PATTERNS,
});
type S6Text = Readonly<{ role: S6Role; text: string }>;
/**
 * Every text S6 reads for one field text whose tokens are already replaced, in a fixed order: for each scan copy, the copy itself
 * (authority rules), its meaning scan text (clinical rules: permitted limitation sentences and negated causes removed, as the shared
 * meaning rules read them) and its directive texts (shellDirectiveScanTexts). This is exactly what r7 read through meaningMatches and
 * shellDirectiveViolation on each scan copy.
 */
function s6Texts(text: string, locale: AiLocale): S6Text[] {
  return shellScanCopies(text, locale).flatMap((scan) => [
    { role: "AUTHORITY" as const, text: scan },
    { role: "CLINICAL" as const, text: meaningScanText(scan) },
    ...shellDirectiveScanTexts(scan, locale).map((entry) => ({ role: "DIRECTIVE" as const, text: entry })),
  ]);
}
const hitIn = (entry: S6Text, occurrences: readonly StandInOccurrence[] | null): boolean =>
  S6_PATTERNS[entry.role].some((pattern) => (occurrences === null ? pattern.test(entry.text) : provenanceSafeMatch(pattern, entry.text, occurrences)));

/**
 * Rules r8 (S6 placeholder provenance), over one field text with its slot tokens. Two readings, a match in either counts:
 * 1. The stand-in reading (r7): each token read as ` <stand-in> ` (the neutral noun of the language copy), so genuine adjacency such
 *    as {{S2}}太高, {{S2}} is too high or 医生{{S2}}看过 still matches. A match counts only when it does not split a stand-in occurrence
 *    (provenanceSafeMatch): it holds none of the stand-in's characters, the whole stand-in, or whole stand-in words standing apart —
 *    never 应 + the 该 of 该项, and never a word made of model and stand-in letters. The provenance comes from shadow builds: for each
 *    token in turn, the same texts built with that one stand-in replaced by its same-shape shadow (standInShadow) are compared
 *    character by character (standInOccurrence); if a stand-in has no shadow or any text is not aligned, that text is read as in r7
 *    (every match counts: fail closed).
 * 2. The token-separated reading: each token as CLINICAL_TOKEN_SEPARATOR, folded, then read as a space (tokenSeparatedScanText), with
 *    the same scan copies, meaning scan texts and directive texts. It holds no stand-in, so a model-written split across a token
 *    (应{{S2}}该, 建{{S2}}议, Pl{{S2}}ease) still rejects through the existing joined-copy rules.
 * The rules, lists, copies and joins are the unchanged r7 ones; only which matches count changes.
 */
export function shellMeaningScan(text: string, locale: AiLocale, standIn: string): ShellMeaningScan {
  const read = stripSlotTokens(text, ` ${standIn} `);
  const standInTexts = s6Texts(read, locale);
  const separatedTexts = s6Texts(tokenSeparatedScanText(stripSlotTokens(text, CLINICAL_TOKEN_SEPARATOR), locale), locale);
  const roles: readonly S6Role[] = ["AUTHORITY", "CLINICAL", "DIRECTIVE"];
  const result: Record<S6Role, boolean> = { AUTHORITY: false, CLINICAL: false, DIRECTIVE: false };
  for (const role of roles) result[role] = separatedTexts.some((entry) => entry.role === role && hitIn(entry, null));
  // Provenance is needed only when the stand-in reading matches something the token-separated reading does not already decide.
  const pending = standInTexts.map((entry, index) => ({ entry, index })).filter(({ entry }) => !result[entry.role] && hitIn(entry, null));
  if (pending.length === 0) return Object.freeze({ authority: result.AUTHORITY, clinical: result.CLINICAL, directive: result.DIRECTIVE });
  const shadow = standInShadow(standIn);
  const tokenCount = [...text.matchAll(slotTokenMatcher())].length;
  // occurrences[i]: the stand-in occurrences of standInTexts[i], or null when its provenance is unknown (fail closed).
  const occurrences: Array<StandInOccurrence[] | null> = standInTexts.map(() => (shadow === null ? null : []));
  if (shadow !== null) {
    for (let token = 0; token < tokenCount; token += 1) {
      let position = -1;
      const shadowed = s6Texts(text.replace(slotTokenMatcher(), () => ((position += 1) === token ? ` ${shadow} ` : ` ${standIn} `)), locale);
      standInTexts.forEach((entry, index) => {
        const own = occurrences[index];
        if (own === null) return;
        const counterpart = shadowed[index];
        const occurrence = shadowed.length === standInTexts.length && counterpart?.role === entry.role ? standInOccurrence(entry.text, counterpart.text, standIn, shadow) : null;
        if (occurrence === null) occurrences[index] = null;
        else own.push(occurrence);
      });
    }
  }
  for (const { entry, index } of pending) if (!result[entry.role] && hitIn(entry, occurrences[index] ?? null)) result[entry.role] = true;
  return Object.freeze({ authority: result.AUTHORITY, clinical: result.CLINICAL, directive: result.DIRECTIVE });
}

export function validateShellCandidate(plan: SlotPlan, bundle: AiHybridRuntimeBundle, candidate: unknown, copy: LanguageCopy = AI_LANGUAGE_COPY): ShellValidationResult {
  const structural = bundle.executionBudget.structuralRepairAllowed;
  const rejected = (gate: ShellGate, reason: ShellValidationReason, repairable = false, detail: { lexical?: readonly ShellLexicalViolation[]; integrity?: ShellIntegrityCode; register?: ShellRegisterCode; quality?: ShellQualityDetail; clinicalLabel?: ShellClinicalLabelCategory } = {}): ShellValidationResult => Object.freeze({ kind: "REJECTED", gate, reason, repairable, ...detail });

  // S1. Strict JSON for a string candidate; never trimmed or repaired.
  let value = candidate;
  if (typeof candidate === "string") {
    try {
      value = toPlainData(parseStrictJson(candidate, { maxDepth: 16, maxLength: 65_536 }));
    } catch (error) {
      if (error instanceof StrictJsonError) return rejected("S1", "SCHEMA_INVALID", structural);
      throw error;
    }
  }
  // S2. Exact shell schema, version, task and locale; the field layout equals the plan.
  const parsed = shellOutputSchema(plan.taskType).safeParse(value);
  if (!parsed.success) return rejected("S2", "SCHEMA_INVALID", structural);
  const output = parsed.data as { schemaVersion: string; slotPlanVersion: string; tokenInventory: readonly string[]; locale: string; outcome: "SUCCESS" | "ABSTAIN"; shells: unknown };
  if (output.schemaVersion !== bundle.shellOutputVersion) return rejected("S2", "SCHEMA_INVALID", structural);
  if (output.locale !== plan.locale) return rejected("S2", "LOCALE_INVALID");
  if (output.outcome === "ABSTAIN") return rejected("S2a", "MODEL_ABSTAINED");
  const texts = flatten(plan, output.shells);
  if (!texts) return rejected("S2", "SCHEMA_INVALID", structural);

  // S3. Echo, then token grammar and closure: the slot plan version and token inventory equal the plan's, and each
  // field's token sequence equals its requiredSlots exactly (each once, only in its home field, in plan order).
  // 11b.18: the remote fields only (the model's fields); the application-owned observation is never echoed or checked here.
  const fields = remoteFields(plan);
  const inventory = remoteTokenInventory(plan);
  if (output.slotPlanVersion !== plan.planVersion || output.tokenInventory.join("|") !== inventory.join("|")) return rejected("S3", "REFERENCE_MISMATCH", false, { integrity: "INVENTORY_MISMATCH" });
  for (const field of fields) {
    const integrity = tokenIntegrity(field, texts.get(field.path)!);
    if (integrity) return rejected("S3", "REFERENCE_MISMATCH", false, { integrity });
  }
  // S4. Budgets on the text outside tokens.
  for (const field of fields) {
    const prose = stripSlotTokens(texts.get(field.path)!, "").trim();
    if ([...prose].length > field.maxCodePoints || countSentences(prose) > field.maxSentences) return rejected("S4", "OUTPUT_BUDGET_EXCEEDED");
    if (!field.mayBeAtomOnly && prose.replace(/[\s\p{P}]/gu, "").length === 0) return rejected("S4", "OUTPUT_BUDGET_EXCEEDED");
  }
  // S4b. Language presence (r2): the EXPLAIN headline and evidence (11b.18: the model's fields; the observation is application-owned),
  // and each care section (its intro or a bullet), carry model-written letters outside the tokens. Same reason as S4's empty framed
  // field; never repairable.
  const presenceGroups: ReadonlyArray<readonly ShellFieldPath[]> = plan.taskType === "EXPLAIN_PATTERN" ? [["headline"], ["evidence"]] : plan.sections.map((section) => [section.introPath, ...section.bulletPaths]);
  for (const group of presenceGroups) {
    if (!group.some((path) => languagePresent(texts.get(path)!, plan.locale))) return rejected("S4b", "OUTPUT_BUDGET_EXCEEDED");
  }
  // S5. Lexical fidelity: the shell may state no fact of any kind (rules on the scan copy, format characters on the text).
  for (const field of fields) {
    // Rules r7 fix round 2: the token-bearing field text is passed for the r7 token/digit guard only.
    const lexical = shellLexicalViolations(stripSlotTokens(texts.get(field.path)!, " "), plan.locale, texts.get(field.path)!);
    if (lexical.length > 0) return rejected("S5", "FACT_FIDELITY_FAILED", false, { lexical: Object.freeze(lexical) });
  }
  // S6. Meaning and directives on the scan copies (zh-SG: also the joined copy), with each token read as a neutral
  // noun so adjacency still matches. Rules r8: with stand-in provenance, plus the token-separated copy (shellMeaningScan).
  for (const field of fields) {
    const scan = shellMeaningScan(texts.get(field.path)!, plan.locale, copy.tokenStandIn[plan.locale]);
    if (scan.authority) return rejected("S6", "AUTHORITY_BOUNDARY_VIOLATION");
    if (scan.clinical || scan.directive) return rejected("S6", "CLINICAL_MEANING_VIOLATION");
  }
  // S6b. Clinical labels (rules r5, matcher r6): the model wording (tokens removed, as S5) names no disease or condition, diagnosis,
  // symptom, medication, treatment or other clinical label on any scan copy. Never repairable; evaluation-only category.
  for (const field of fields) {
    // Fix round 1: tokens become CLINICAL_TOKEN_SEPARATOR, so a neutral phrase never matches across a token.
    const clinicalLabel = shellClinicalLabel(stripSlotTokens(texts.get(field.path)!, CLINICAL_TOKEN_SEPARATOR), plan.locale);
    if (clinicalLabel) return rejected("S6b", "CLINICAL_MEANING_VIOLATION", false, { clinicalLabel });
  }
  // S7. Locale of the model-written text: both the original text and its scan copy must pass (no relaxation vs r1).
  // Rules r4: then the zh-SG register (no 你/妳), with the evaluation-only register detail.
  for (const field of fields) {
    const original = stripSlotTokens(texts.get(field.path)!, " ");
    if (!localeTextAccepted(original, plan.locale) || !localeTextAccepted(foldShellScanText(original, plan.locale), plan.locale)) return rejected("S7", "LOCALE_INVALID");
    const register = shellRegisterViolation(original, plan.locale);
    if (register) return rejected("S7", "LOCALE_INVALID", false, { register });
  }
  // S7b. Meaningful wording (rules r4): every model-written EXPLAIN field (headline, evidence) and every care section intro carries a meaningful
  // model-written phrase outside the tokens; bullets may stay fact only. Run last (see the header); reason
  // OUTPUT_BUDGET_EXCEEDED, never repairable, with the evaluation-only quality detail.
  for (const path of meaningfulWordingPaths(plan)) {
    if (!meaningfulWording(texts.get(path)!, plan.locale)) {
      const fieldKind: ShellWordingFieldKind = path === "headline" || path === "observation" || path === "evidence" ? path : "intro";
      return rejected("S7b", "OUTPUT_BUDGET_EXCEEDED", false, { quality: Object.freeze({ code: "NOT_MEANINGFUL", fieldKind }) });
    }
  }
  return Object.freeze({ kind: "VALID", shells: texts });
}
