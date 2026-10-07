import type { AiTaskRequest, AtomTable, SlotPlan } from "@/domain/ai";
import type { AiHybridRuntimeBundle } from "../ai-hybrid-runtime-bundles";
import { AI_LANGUAGE_COPY, type LanguageCopy } from "./ai-language-copy";
import { assembleComposition, type AiComposition } from "./assembler";
import { defaultShells } from "./default-shells";

/**
 * Packet 11B.6 deterministic composition (spec Section 9.2): approved default shells around the identical
 * atoms. Used for private, offline and unactivated modes and for every failure. Adjacency checks are not
 * applied: the copy is approved, and a patient label next to approved wording is never a fidelity fault.
 */
export function composeDeterministic(request: AiTaskRequest, plan: SlotPlan, atoms: AtomTable, bundle: AiHybridRuntimeBundle, copy: LanguageCopy = AI_LANGUAGE_COPY): AiComposition {
  const result = assembleComposition(request, plan, atoms, defaultShells(plan, copy), bundle, { adjacencyChecks: false });
  if (result.kind !== "ASSEMBLED") throw new Error("DETERMINISTIC_COMPOSITION_INVALID");
  return result.composition;
}

export function atomMultiset(composition: AiComposition): string[] {
  return [...composition.fields.values()].flatMap((field) => field.spans.map((span) => `${span.slotId}=${field.text.slice(span.start, span.end)}`)).sort();
}
