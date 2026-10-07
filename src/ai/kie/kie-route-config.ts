import type { AiTaskRuntimeBundle } from "@/application/ai/ai-runtime-bundles";
import { KIE_DOCUMENTED_MODELS, type KieDocumentedModel, type KieModelSnapshot } from "./kie-model-catalogue";

/**
 * Kie route configuration (Packet 11B Task 1). Server-only.
 *
 * - `KIE_API_KEY` is the only credential name; a `NEXT_PUBLIC_*` copy is never
 *   read. Absence is a typed deterministic-fallback reason, not an exception.
 * - Evaluation candidates are explicit command inputs that must exactly match
 *   the fresh listing or the owner-approved documented-unlisted registry.
 * - The product route reads its model only from the immutable runtime bundle;
 *   there is no mutable model environment variable. In 11B every bundle still
 *   carries `modelSnapshot: null`, so product routing stays unavailable.
 */

export type KieTokenConfiguration = { kind: "CONFIGURED"; token: string } | { kind: "MISSING_CONFIGURATION" };

export function readKieToken(environment: Readonly<Record<string, string | undefined>>): KieTokenConfiguration {
  const token = environment.KIE_API_KEY?.trim();
  return token ? { kind: "CONFIGURED", token } : { kind: "MISSING_CONFIGURATION" };
}

export type CandidateSelection =
  | { kind: "SELECTED"; candidates: KieModelSnapshot[] }
  | { kind: "REJECTED"; reason: "NO_CANDIDATES" | "UNKNOWN_MODEL" | "DUPLICATE_CANDIDATE" | "FLOATING_ALIAS" | "EXCLUDED_MODEL" };

/**
 * Models the owner has ruled out of Packet 11 evaluation (2026-10-06): DeepSeek V4.1 Flash failed
 * qualification and Kimi K3 is excluded. Refused before any request, even when listed or documented.
 */
export const KIE_EXCLUDED_EVALUATION_MODELS = Object.freeze(["deepseek-v4-1-flash", "kimi-k3"] as const);

const FLOATING_SUFFIX = /(^|[-.])(latest|default|auto|preview)$/i;
const withoutVersions = (id: string) =>
  id
    .split("-")
    .filter((segment) => !/\d/.test(segment))
    .join("-");

/** A request that names a moving family or alias where an exact identifier exists. */
function isFloatingAlias(requested: string, known: readonly string[]): boolean {
  if (FLOATING_SUFFIX.test(requested)) return true;
  if (known.some((id) => id.startsWith(requested) && /[-.]/.test(id.charAt(requested.length)))) return true;
  return !/\d/.test(requested) && known.some((id) => withoutVersions(id) === requested);
}

function fromDocumentation(model: KieDocumentedModel, retrievedAt: string): KieModelSnapshot {
  return Object.freeze({
    requestModelId: model.requestModelId,
    responseModelSnapshot: model.responseModelSnapshot,
    provenance: model.provenance,
    endpoint: model.endpoint,
    contextWindow: null,
    defaultReasoningLevel: null,
    supportedReasoningLevels: model.supportedReasoningLevels,
    retrievedAt,
    documentationUrl: model.documentationUrl,
  });
}

export function selectEvaluationCandidates(options: { requested: string | undefined; listing: readonly KieModelSnapshot[]; documented?: readonly KieDocumentedModel[]; now: () => string }): CandidateSelection {
  const documented = options.documented ?? KIE_DOCUMENTED_MODELS;
  const requested = (options.requested ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requested.length === 0) return { kind: "REJECTED", reason: "NO_CANDIDATES" };
  if (new Set(requested).size !== requested.length) return { kind: "REJECTED", reason: "DUPLICATE_CANDIDATE" };

  const known = [...options.listing.map((model) => model.requestModelId), ...documented.map((model) => model.requestModelId)];
  const candidates: KieModelSnapshot[] = [];
  for (const id of requested) {
    if ((KIE_EXCLUDED_EVALUATION_MODELS as readonly string[]).includes(id)) return { kind: "REJECTED", reason: "EXCLUDED_MODEL" };
    const listed = options.listing.find((model) => model.requestModelId === id);
    if (listed) {
      candidates.push(listed);
      continue;
    }
    const documentedModel = documented.find((model) => model.requestModelId === id);
    if (documentedModel) {
      candidates.push(fromDocumentation(documentedModel, options.now()));
      continue;
    }
    return { kind: "REJECTED", reason: isFloatingAlias(id, known) ? "FLOATING_ALIAS" : "UNKNOWN_MODEL" };
  }
  return { kind: "SELECTED", candidates };
}

/** The lowest documented effort that disables or minimises reasoning; anything higher is incompatible. */
export function minimumReasoningEffort(model: KieModelSnapshot): "none" | "minimal" | "low" | null {
  for (const effort of ["none", "minimal", "low"] as const) if (model.supportedReasoningLevels.includes(effort)) return effort;
  return null;
}

export type ProductKieRoute = { kind: "CONFIGURED"; token: string; model: KieModelSnapshot } | { kind: "MISSING_CONFIGURATION" };

/** The product route uses only an owner-approved snapshot pinned in the runtime bundle. */
export function resolveProductKieRoute(bundle: AiTaskRuntimeBundle, environment: Readonly<Record<string, string | undefined>>): ProductKieRoute {
  const token = readKieToken(environment);
  if (token.kind === "MISSING_CONFIGURATION") return token;
  // 11B: every bundle's `modelSnapshot` is the literal `null` until the owner approves an exact
  // snapshot; a documented-unlisted model is never pinned. There is no other model source.
  void bundle.modelSnapshot;
  return { kind: "MISSING_CONFIGURATION" };
}
