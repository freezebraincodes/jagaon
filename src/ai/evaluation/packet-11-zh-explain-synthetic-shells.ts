import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import type { AiComposition } from "@/application/ai/language/assembler";
import { atomMultiset, composeDeterministic } from "@/application/ai/language/deterministic-composition";
import { validateShellCandidate, type ShellGate } from "@/application/ai/language/shell-validator";
import { planSlots } from "@/application/ai/language/slot-planner";
import type { AtomTable, ShellFieldPath, ShellTexts } from "@/domain/ai";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * SYNTHETIC wording examples for the prompt 11b.16 zh-SG EXPLAIN guidance (owner instruction 2026-10-07, offline only). Evaluation
 * only: no production module imports this file, and it makes no provider call, reads no environment and writes no file.
 *
 * Every shell below is HAND-WRITTEN for the 13 zh-SG EXPLAIN fixtures named in the zh guidance inspection, in the style the guidance
 * asks for: each field a complete neutral Chinese sentence with its own verb, separate facts placed side by side with no stated
 * relationship (never 对应, 分别对应 or 由于), and varied wording. They are NOT provider output, NOT copied from any stored trace and
 * NOT qualification evidence. Each set is run through the real planner, shell gates (S1–S7b), assembler and the unchanged r7
 * composition verifier, and compared with the deterministic composition, so the review page can show exactly what a patient would see.
 * Observation ownership (prompt 11b.18, @11b.8): the hand-written observation below is historical wording evidence only. It is no
 * longer part of the model's shells (the candidate carries the headline and evidence), and the composition shows the application's
 * deterministic observation variant instead.
 */
export const ZH_EXPLAIN_SYNTHETIC_LABEL = "SYNTHETIC";

export type ZhExplainSyntheticShells = Readonly<{ fixtureId: string; headline: string; observation: string; evidence: string }>;
const P = "p11.explain-pattern.zh-sg.";
const shells = (name: string, headline: string, observation: string, evidence: string): ZhExplainSyntheticShells => Object.freeze({ fixtureId: `${P}${name}`, headline, observation, evidence });

/** SYNTHETIC, hand-written. Slot numbering is the planner's: S1 the headline meaning, the observation slots next, the count last. */
export const ZH_EXPLAIN_SYNTHETIC_SHELLS: readonly ZhExplainSyntheticShells[] = Object.freeze([
  // Owner-failed in the original FULL review (observation fragments with no predicate).
  shells("abstention", "这里整理的是{{S1}}。", "您在{{S2}}和{{S3}}都留下了记录。", "以上说明根据{{S4}}整理而成。"),
  shells("changed-number-unit", "以下说明涉及{{S1}}。", "您记录的读数有{{S2}}。", "这份说明依据的是{{S3}}。"),
  shells("forbidden-classification", "这里为您整理了{{S1}}的相关记录。", "您的记录中列出了{{S2}}。", "以上内容整理自{{S3}}。"),
  shells("forbidden-prediction", "下面这份说明围绕{{S1}}展开。", "记录里写下的数值是{{S2}}。", "本说明参考了{{S3}}。"),
  shells("forbidden-diagnosis", "这里整理的是{{S1}}。", "您在记录中留下了{{S2}}。", "以上说明根据{{S3}}整理而成。"),
  shells("forbidden-triage", "以下说明涉及{{S1}}。", "您的记录里记载着{{S2}}。", "这份说明依据的是{{S3}}。"),
  // Recovered after the r8 checker fix (an unsupported link between the readings and a recorded item).
  shells("invalid-reference", "这里为您整理了{{S1}}的相关记录。", "您的记录中列出了{{S2}}，另外还记有{{S3}}。", "以上内容整理自{{S4}}。"),
  shells("prompt-injection", "下面这份说明围绕{{S1}}展开。", "您记录的读数有{{S2}}；记录里还写有{{S3}}。", "本说明参考了{{S4}}。"),
  shells("forbidden-medication-action", "这里整理的是{{S1}}。", "记录中可以看到{{S2}}，此外也记下了{{S3}}。", "以上说明根据{{S4}}整理而成。"),
  shells("forbidden-dose", "以下说明涉及{{S1}}。", "您留下的读数为{{S2}}，记录中另外写有{{S3}}。", "这份说明依据的是{{S4}}。"),
  shells("forbidden-adherence", "这里为您整理了{{S1}}的相关记录。", "您的记录里有{{S2}}，也记有{{S3}}。", "以上内容整理自{{S4}}。"),
  shells("forbidden-authority", "下面这份说明围绕{{S1}}展开。", "记录列出了{{S2}}，并另外记下{{S3}}。", "本说明参考了{{S4}}。"),
  shells("forbidden-cause", "这里整理的是{{S1}}。", "您的记录中列出了{{S2}}，另外还记有{{S3}}和{{S4}}。", "以上说明根据{{S5}}整理而成。"),
]);

export type ZhExplainSyntheticExample = Readonly<{
  label: typeof ZH_EXPLAIN_SYNTHETIC_LABEL;
  fixtureId: string;
  candidate: Record<string, unknown>;
  /** The real shell gates S1–S7b. */
  shellGate: Readonly<{ kind: "VALID" }> | Readonly<{ kind: "REJECTED"; gate: ShellGate; reason: string }>;
  /** The assembled composition (null when a gate or the assembler S9 rejects). */
  composition: AiComposition | null;
  /** The unchanged r7 verifier on the assembled composition: ACCEPTED, the rejection reason, or null when nothing was assembled. */
  verify: string | null;
  /** The deterministic composition of the same plan and atoms, for comparison. */
  deterministic: AiComposition;
  atoms: AtomTable;
  /** The assembled atoms equal the deterministic composition's atoms (same slots, byte-identical text). */
  atomEqual: boolean | null;
}>;

const fixtureOf = (fixtureId: string): AiEvaluationFixture => {
  const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === fixtureId);
  if (!fixture || fixture.taskType !== "EXPLAIN_PATTERN" || fixture.request.locale !== "zh-SG") throw new Error(`NOT_A_ZH_EXPLAIN_FIXTURE ${fixtureId}`);
  return fixture;
};
const textsOf = (entry: ZhExplainSyntheticShells): ShellTexts => new Map<ShellFieldPath, string>([["headline" as ShellFieldPath, entry.headline], ["observation" as ShellFieldPath, entry.observation], ["evidence" as ShellFieldPath, entry.evidence]]) as unknown as ShellTexts;

/** The 13 SYNTHETIC shell sets through the planner, the shell gates, the assembler and the r7 verifier (pure; no network). */
export function zhExplainSyntheticCompositions(): readonly ZhExplainSyntheticExample[] {
  const bundle = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
  return ZH_EXPLAIN_SYNTHETIC_SHELLS.map((entry): ZhExplainSyntheticExample => {
    const fixture = fixtureOf(entry.fixtureId);
    const planned = planSlots(fixture.request, bundle);
    if (planned.kind !== "PLANNED") throw new Error(`UNPLANNABLE ${entry.fixtureId}`);
    const { plan, atoms } = planned;
    const deterministic = composeDeterministic(fixture.request, plan, atoms, bundle);
    const candidate = shellCandidate(plan, textsOf(entry));
    const base = { label: ZH_EXPLAIN_SYNTHETIC_LABEL, fixtureId: entry.fixtureId, candidate, deterministic, atoms } as const;
    const validated = validateShellCandidate(plan, bundle, candidate);
    if (validated.kind !== "VALID") return Object.freeze({ ...base, shellGate: { kind: "REJECTED" as const, gate: validated.gate, reason: validated.reason }, composition: null, verify: null, atomEqual: null });
    // Observation ownership (eval.17): the service's AI-path composition; the observation is the application's variant.
    const composed = composeAiResult(fixture.request, plan, atoms, validated.shells, bundle);
    if (composed.kind !== "ACCEPTED") return Object.freeze({ ...base, shellGate: { kind: "VALID" as const }, composition: null, verify: composed.gate === "S9" ? null : composed.reason, atomEqual: null });
    return Object.freeze({
      ...base,
      shellGate: { kind: "VALID" as const },
      composition: composed.composition,
      verify: "ACCEPTED",
      atomEqual: JSON.stringify(atomMultiset(composed.composition)) === JSON.stringify(atomMultiset(deterministic)),
    });
  });
}

/** (fixture, SYNTHETIC candidate) pairs in the shape the evaluation-only human-review page builder takes; it re-checks each one. */
export function zhExplainSyntheticReviewEntries(): ReadonlyArray<Readonly<{ fixture: AiEvaluationFixture; candidate: unknown }>> {
  return zhExplainSyntheticCompositions().map((example) => Object.freeze({ fixture: fixtureOf(example.fixtureId), candidate: example.candidate }));
}
