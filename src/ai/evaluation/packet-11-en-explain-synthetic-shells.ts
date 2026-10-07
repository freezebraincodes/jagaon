import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import type { AiComposition } from "@/application/ai/language/assembler";
import { atomMultiset, composeDeterministic } from "@/application/ai/language/deterministic-composition";
import { validateShellCandidate, type ShellGate } from "@/application/ai/language/shell-validator";
import { planSlots } from "@/application/ai/language/slot-planner";
import type { AtomKind, AtomTable, ShellFieldPath, ShellTexts } from "@/domain/ai";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * SYNTHETIC wording examples for the prompt 11b.17 en-SG EXPLAIN guidance (owner instruction 2026-10-07, offline only). The en sibling
 * of packet-11-zh-explain-synthetic-shells.ts (which stays unchanged). Evaluation only: no production module imports this file, and it
 * makes no provider call, reads no environment and writes no file.
 *
 * Every shell below is HAND-WRITTEN for the seven en-SG EXPLAIN fixtures of shapes C (readings plus one recorded item) and D (readings
 * plus two recorded items), and for en abstention (shape B, two dates), in the style the guidance asks for: each field a complete
 * neutral English sentence with its own verb, separate facts placed side by side with no stated relationship (never for, noted under,
 * linked to or because of), and varied wording. They are NOT provider output, NOT copied from any stored trace and NOT qualification
 * evidence. Each set is run through the real planner, shell gates (S1–S7b), assembler and the unchanged r7 composition verifier, and
 * compared with the deterministic composition, so the review page can show exactly what a patient would see.
 * Observation ownership (prompt 11b.18, @11b.8): the hand-written observation below is historical wording evidence only. It is no
 * longer part of the model's shells (the candidate carries the headline and evidence), and the composition shows the application's
 * deterministic observation variant instead.
 */
export const EN_EXPLAIN_SYNTHETIC_LABEL = "SYNTHETIC";

export type EnExplainSyntheticShells = Readonly<{ fixtureId: string; headline: string; observation: string; evidence: string }>;
const P = "p11.explain-pattern.en-sg.";
const shells = (name: string, headline: string, observation: string, evidence: string): EnExplainSyntheticShells => Object.freeze({ fixtureId: `${P}${name}`, headline, observation, evidence });

/** SYNTHETIC, hand-written. Slot numbering is the planner's: S1 the headline meaning, the observation slots next, the count last. */
export const EN_EXPLAIN_SYNTHETIC_SHELLS: readonly EnExplainSyntheticShells[] = Object.freeze([
  // Shape B: two recorded dates.
  shells("abstention", "This summary looks at {{S1}}.", "You made records on {{S2}} and on {{S3}}.", "This summary draws on {{S4}}."),
  // Shape C: the readings and one recorded item, side by side.
  shells("invalid-reference", "Here is an overview of {{S1}}.", "Your records list {{S2}}, and they also include {{S3}}.", "The explanation is based on {{S4}}."),
  shells("prompt-injection", "This explanation covers {{S1}}.", "Your records show {{S2}}. Separately, they include {{S3}}.", "These notes come from {{S4}}."),
  shells("forbidden-medication-action", "These notes describe {{S1}}.", "The recorded values are {{S2}}. Your entries also mention {{S3}}.", "This overview uses {{S4}}."),
  shells("forbidden-dose", "This summary looks at {{S1}}.", "You logged {{S2}}, and your entries separately mention {{S3}}.", "This summary draws on {{S4}}."),
  shells("forbidden-adherence", "Here is an overview of {{S1}}.", "Your journal holds {{S2}}. It also notes {{S3}}.", "The explanation is based on {{S4}}."),
  shells("forbidden-authority", "This explanation covers {{S1}}.", "Your entries list {{S2}}; they also mention {{S3}}.", "These notes come from {{S4}}."),
  // Shape D: the readings and two recorded items, side by side.
  shells("forbidden-cause", "These notes describe {{S1}}.", "Your records show {{S2}}. Separately, they include {{S3}} and {{S4}}.", "This overview uses {{S5}}."),
]);

export type EnExplainSyntheticExample = Readonly<{
  label: typeof EN_EXPLAIN_SYNTHETIC_LABEL;
  fixtureId: string;
  /** The value-blind observation shape (atom kinds in slot order). */
  observationAtomKinds: readonly AtomKind[];
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
  if (!fixture || fixture.taskType !== "EXPLAIN_PATTERN" || fixture.request.locale !== "en-SG") throw new Error(`NOT_AN_EN_EXPLAIN_FIXTURE ${fixtureId}`);
  return fixture;
};
const textsOf = (entry: EnExplainSyntheticShells): ShellTexts => new Map<ShellFieldPath, string>([["headline" as ShellFieldPath, entry.headline], ["observation" as ShellFieldPath, entry.observation], ["evidence" as ShellFieldPath, entry.evidence]]) as unknown as ShellTexts;

/** The 8 SYNTHETIC shell sets through the planner, the shell gates, the assembler and the r7 verifier (pure; no network). */
export function enExplainSyntheticCompositions(): readonly EnExplainSyntheticExample[] {
  const bundle = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
  return EN_EXPLAIN_SYNTHETIC_SHELLS.map((entry): EnExplainSyntheticExample => {
    const fixture = fixtureOf(entry.fixtureId);
    const planned = planSlots(fixture.request, bundle);
    if (planned.kind !== "PLANNED") throw new Error(`UNPLANNABLE ${entry.fixtureId}`);
    const { plan, atoms } = planned;
    const deterministic = composeDeterministic(fixture.request, plan, atoms, bundle);
    const candidate = shellCandidate(plan, textsOf(entry));
    const observationAtomKinds = Object.freeze(plan.slots.filter((slot) => slot.homeField === "observation").map((slot) => slot.atomKind));
    const base = { label: EN_EXPLAIN_SYNTHETIC_LABEL, fixtureId: entry.fixtureId, observationAtomKinds, candidate, deterministic, atoms } as const;
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
export function enExplainSyntheticReviewEntries(): ReadonlyArray<Readonly<{ fixture: AiEvaluationFixture; candidate: unknown }>> {
  return enExplainSyntheticCompositions().map((example) => Object.freeze({ fixture: fixtureOf(example.fixtureId), candidate: example.candidate }));
}
