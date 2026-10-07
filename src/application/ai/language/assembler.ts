import { deepFreeze } from "@/application/deep-freeze";
import { slotTokenMatcher, type AiLocale, type AiTaskOutput, type AiTaskRequest, type AtomTable, type ShellFieldPath, type ShellTask, type ShellTexts, type SlotId, type SlotPlan } from "@/domain/ai";
import type { AiHybridRuntimeBundle } from "../ai-hybrid-runtime-bundles";
import { validateAiTaskOutput, type AiValidationResult } from "../ai-output-validator";

/**
 * Packet 11B.6 assembler (spec Sections 8.1 S8–S10, 9.1). Deterministic and pure: substitutes every token
 * once with its atom (atoms are never modified), normalises only shell segments, binds every reference from
 * the plan and re-validates the assembled output with the unchanged r7 validator.
 */
export type AtomSpan = Readonly<{ slotId: SlotId; start: number; end: number }>;
export type AssembledField = Readonly<{ text: string; spans: readonly AtomSpan[]; segments: readonly string[] }>;
export type SuccessOutput = Extract<AiTaskOutput, { outcome: "SUCCESS" }>;
export type AiComposition = Readonly<{ taskType: ShellTask; locale: AiLocale; output: SuccessOutput; sectionIntros: Readonly<Record<string, string>>; fields: ReadonlyMap<ShellFieldPath, AssembledField> }>;
export type AssemblyResult = Readonly<{ kind: "ASSEMBLED"; composition: AiComposition }> | Readonly<{ kind: "REJECTED"; reason: "FACT_FIDELITY_FAILED"; gate: "S9" }>;

// Escaped, not literal: Unicode normalisation of a raw U+F900 (to U+8C48) would silently widen the range over Hangul.
const CJK_IDEOGRAPH = /[\u3400-\u9fff\uf900-\ufaff]/;
const CJK_RUN = "[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]";
const PUNCTUATION = new Set([".", "。", "!", "！", "?", "？", ",", "，", ";", "；", ":", "："]);

function normalise(segment: string, locale: AiLocale): string {
  const collapsed = segment.replace(/\s+/g, " ");
  if (locale === "en-SG") return collapsed.replace(/ +(?=[,.;:!?])/g, "");
  return collapsed.replace(new RegExp(` +(?=${CJK_RUN})`, "g"), "").replace(new RegExp(`(?<=${CJK_RUN}) +`, "g"), "");
}

function fit(segment: string, left: string | null, right: string | null, locale: AiLocale): string {
  let text = normalise(segment, locale);
  if (locale === "en-SG") {
    if (left !== null) {
      if (/^ ?[,.;:!?)]/.test(text)) text = text.replace(/^ /, "");
      else if (/^[A-Za-z0-9(“"]/.test(text) && /[A-Za-z0-9.”"?!)]$/.test(left)) text = ` ${text}`;
    }
    if (right !== null && /[A-Za-z0-9,;:]$/.test(text) && /^[A-Za-z0-9“"(]/.test(right)) text = `${text} `;
  } else {
    if (left !== null) {
      if (/^ ?[　-〿＀-￯]/.test(text)) text = text.replace(/^ /, "");
      else if (CJK_IDEOGRAPH.test(text.charAt(0)) && /[A-Za-z0-9/)]$/.test(left)) text = ` ${text}`;
    }
    if (right !== null) {
      if (/[　-〿＀-￯] $/.test(text)) text = text.replace(/ $/, "");
      else if (CJK_IDEOGRAPH.test(text.charAt(text.length - 1)) && /^[A-Za-z0-9]/.test(right)) text = `${text} `;
    }
  }
  if (left === null) text = text.replace(/^ /, "");
  if (right === null) text = text.replace(/ $/, "");
  return text;
}

export function assembleField(shell: string, atoms: AtomTable, locale: AiLocale): AssembledField {
  const parts = shell.split(slotTokenMatcher());
  const segments = parts.filter((_, index) => index % 2 === 0);
  const slots = parts.filter((_, index) => index % 2 === 1) as SlotId[];
  const atom = (slotId: SlotId) => {
    const entry = atoms[slotId];
    if (!entry) throw new Error("ATOM_MISSING");
    return entry.text;
  };
  const fitted = segments.map((segment, index) => fit(segment, index === 0 ? null : atom(slots[index - 1]!), index === slots.length ? null : atom(slots[index]!), locale));
  let text = fitted[0]!;
  const spans: AtomSpan[] = [];
  slots.forEach((slotId, index) => {
    const start = text.length;
    text += atom(slotId);
    spans.push(Object.freeze({ slotId, start, end: text.length }));
    text += fitted[index + 1]!;
  });
  return Object.freeze({ text, spans: Object.freeze(spans), segments: Object.freeze(fitted) });
}

const lastWord = (text: string) => text.match(/([A-Za-z]+)[^A-Za-z]*$/)?.[1]?.toLowerCase() ?? "";
const firstWord = (text: string) => text.match(/^[^A-Za-z]*([A-Za-z]+)/)?.[1]?.toLowerCase() ?? "";
const twoIdeographs = (text: string) => ([...text].length === 2 && [...text].every((char) => CJK_IDEOGRAPH.test(char)) ? text : "");

function adjacencyViolation(field: AssembledField, atoms: AtomTable, locale: AiLocale): boolean {
  if (field.text.trim().length === 0) return true;
  return field.spans.some((span, index) => {
    const atom = atoms[span.slotId]!.text;
    const before = field.segments[index]!;
    const after = field.segments[index + 1]!;
    if (locale === "en-SG") {
      if (/^[A-Za-z]/.test(atom) && /[A-Za-z]\s*$/.test(before) && lastWord(before) === firstWord(atom)) return true;
      if (/[A-Za-z]$/.test(atom) && /^\s*[A-Za-z]/.test(after) && lastWord(atom) === firstWord(after)) return true;
    } else {
      const tail = twoIdeographs([...before.trimEnd()].slice(-2).join(""));
      if (tail && tail === [...atom].slice(0, 2).join("")) return true;
      const head = twoIdeographs([...after.trimStart()].slice(0, 2).join(""));
      if (head && head === [...atom].slice(-2).join("")) return true;
    }
    const atomLast = atom.charAt(atom.length - 1);
    const atomFirst = atom.charAt(0);
    return (PUNCTUATION.has(atomLast) && atomLast === after.charAt(0)) || (PUNCTUATION.has(atomFirst) && atomFirst === before.charAt(before.length - 1));
  });
}

const unique = (values: readonly string[]) => [...new Set(values)];

export function assembleComposition(request: AiTaskRequest, plan: SlotPlan, atoms: AtomTable, shells: ShellTexts, bundle: AiHybridRuntimeBundle, options: { adjacencyChecks: boolean } = { adjacencyChecks: true }): AssemblyResult {
  const fields = new Map<ShellFieldPath, AssembledField>();
  for (const spec of plan.fields) {
    const shell = shells.get(spec.path);
    if (shell === undefined) throw new Error("SHELL_MISSING");
    const field = assembleField(shell, atoms, plan.locale);
    if (options.adjacencyChecks && adjacencyViolation(field, atoms, plan.locale)) return Object.freeze({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", gate: "S9" });
    fields.set(spec.path, field);
  }
  const schemaVersion = `${bundle.outputSchema.id}@${bundle.outputSchema.version}`;
  const sectionIntros: Record<string, string> = {};
  let output: SuccessOutput;
  if (request.taskType === "EXPLAIN_PATTERN") {
    const claim = request.taskPayload.claim;
    output = {
      schemaVersion, taskType: "EXPLAIN_PATTERN", outcome: "SUCCESS", locale: plan.locale, inputRefsUsed: unique([claim.ref, ...claim.factRefs]),
      payload: {
        headline: { text: fields.get("headline")!.text, claimRefs: [claim.ref] },
        observation: { text: fields.get("observation")!.text, claimRefs: [claim.ref] },
        evidence: { text: fields.get("evidence")!.text, factRefs: [...claim.factRefs] },
      },
    } as SuccessOutput;
  } else {
    const refsOf = (path: ShellFieldPath) => unique(plan.slots.filter((slot) => slot.homeField === path).flatMap((slot) => slot.boundRefs));
    const sections = plan.sections.map((section) => {
      sectionIntros[section.sectionRef] = fields.get(section.introPath)!.text;
      return { sectionRef: section.sectionRef, bullets: section.bulletPaths.map((path) => ({ text: fields.get(path)!.text, factRefs: refsOf(path) })) };
    });
    output = {
      schemaVersion, taskType: "DRAFT_CARE_PREPARATION_SUMMARY", outcome: "SUCCESS", locale: plan.locale,
      inputRefsUsed: unique([...sections.map((section) => section.sectionRef), ...sections.flatMap((section) => section.bullets.flatMap((bullet) => bullet.factRefs))]),
      payload: { sections },
    } as SuccessOutput;
  }
  return Object.freeze({ kind: "ASSEMBLED", composition: Object.freeze({ taskType: plan.taskType, locale: plan.locale, output: deepFreeze(output), sectionIntros: Object.freeze(sectionIntros), fields }) });
}

/**
 * The separator the care validation view puts between a section intro and its first bullet. The planner
 * reserves its width once per section under the output ceiling, so S10 counts exactly what was budgeted.
 */
export const validationViewJoin = (locale: AiLocale): string => (locale === "en-SG" ? " " : "");

export function compositionValidationView(composition: AiComposition): SuccessOutput {
  const output = composition.output;
  if (output.taskType !== "DRAFT_CARE_PREPARATION_SUMMARY") return output;
  const join = validationViewJoin(composition.locale);
  const sections = output.payload.sections.map((section) => ({
    ...section,
    bullets: section.bullets.map((bullet, index) => (index === 0 ? { ...bullet, text: `${composition.sectionIntros[section.sectionRef] ?? ""}${join}${bullet.text}` } : bullet)),
  }));
  return { ...output, payload: { sections } } as SuccessOutput;
}

export function verifyComposition(request: AiTaskRequest, bundle: AiHybridRuntimeBundle, composition: AiComposition): AiValidationResult {
  return validateAiTaskOutput(request, bundle, compositionValidationView(composition));
}
