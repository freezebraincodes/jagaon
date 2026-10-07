import type { AiReasonCode, AiTaskRequest, AtomTable, ShellFieldPath, ShellTexts, SlotPlan } from "@/domain/ai";
import type { AiHybridRuntimeBundle } from "../ai-hybrid-runtime-bundles";
import { AI_LANGUAGE_COPY, type LanguageCopy } from "./ai-language-copy";
import { assembleComposition, verifyComposition, type AiComposition } from "./assembler";
import { assertShellClosure } from "./default-shells";
import { composeLocalShells, isObservationCompositionError, selectObservationVariant } from "./observation-composer";

/**
 * Observation ownership (owner instruction 2026-10-07, offline): the one AI-path composition step shared by the hybrid service and
 * the evaluation replays. The validated model shells (REMOTE fields only: EXPLAIN headline and evidence; every care field) are
 * merged with the application's deterministic LOCAL shells (the EXPLAIN observation, `composeLocalShells`, variant selected from the
 * requestId unless given), every field's tokens are closed against the plan, the EXISTING assembler substitutes the existing atoms
 * (exact rendering, provenance spans, adjacency checks S9) and the unchanged r7 validator verifies the whole output (S10).
 *
 * A composer or merge failure (a remote shell for a local field, a missing remote field, an unknown variant, an over-budget
 * template, a token closure mismatch) is an assembly invariant failure: gate S10 with invariant COMPOSER, reason
 * FACT_FIDELITY_FAILED (an evaluation hard-gate reason). An r7 rejection is S10 with invariant VERIFIER. Neither is ever bypassed.
 */
export type AiCompositionResult =
  | Readonly<{ kind: "ACCEPTED"; composition: AiComposition; observationVariant: number | null }>
  | Readonly<{ kind: "REJECTED"; gate: "S9"; reason: "FACT_FIDELITY_FAILED" }>
  | Readonly<{ kind: "REJECTED"; gate: "S10"; reason: AiReasonCode; invariant: "COMPOSER" | "VERIFIER" }>;

export function composeAiResult(
  request: AiTaskRequest,
  plan: SlotPlan,
  atoms: AtomTable,
  remoteShells: ShellTexts,
  bundle: AiHybridRuntimeBundle,
  options: Readonly<{ variant?: number; copy?: LanguageCopy; verify?: typeof verifyComposition }> = {},
): AiCompositionResult {
  const copy = options.copy ?? AI_LANGUAGE_COPY;
  const verify = options.verify ?? verifyComposition;
  const hasLocal = plan.fields.some((field) => field.owner === "LOCAL");
  const variant = hasLocal ? (options.variant ?? selectObservationVariant(request.requestId, plan.locale, copy)) : null;
  let merged: ShellTexts;
  try {
    const local = variant === null ? new Map<ShellFieldPath, string>() : composeLocalShells(plan, variant, copy);
    const texts = new Map<ShellFieldPath, string>();
    const remotePaths = new Set(plan.fields.filter((field) => field.owner === "REMOTE").map((field) => field.path));
    // The model shells must be exactly the remote fields: never a local field, never a missing or unknown one.
    if (remoteShells.size !== remotePaths.size || [...remoteShells.keys()].some((path) => !remotePaths.has(path))) throw new Error("OBSERVATION_COMPOSITION_INVALID");
    for (const field of plan.fields) {
      const text = field.owner === "REMOTE" ? remoteShells.get(field.path) : local.get(field.path);
      if (text === undefined) throw new Error("OBSERVATION_COMPOSITION_INVALID");
      texts.set(field.path, text);
    }
    merged = texts as ShellTexts;
    assertShellClosure(plan, merged);
  } catch (error) {
    if (!isObservationCompositionError(error) && !(error instanceof Error && (error.message === "OBSERVATION_COMPOSITION_INVALID" || error.message === "DEFAULT_SHELL_TOKEN_MISMATCH"))) throw error;
    return Object.freeze({ kind: "REJECTED", gate: "S10", reason: "FACT_FIDELITY_FAILED", invariant: "COMPOSER" });
  }
  const assembled = assembleComposition(request, plan, atoms, merged, bundle);
  if (assembled.kind === "REJECTED") return assembled;
  const verified = verify(request, bundle, assembled.composition);
  if (verified.kind !== "ACCEPTED") return Object.freeze({ kind: "REJECTED", gate: "S10", reason: verified.reason, invariant: "VERIFIER" });
  return Object.freeze({ kind: "ACCEPTED", composition: assembled.composition, observationVariant: variant });
}
