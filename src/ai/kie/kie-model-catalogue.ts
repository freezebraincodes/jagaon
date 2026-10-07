import { z } from "zod";

/**
 * Current Kie.ai model discovery (Packet 11B Task 1). Server-only.
 *
 * Documentation rechecked 2026-10-04/05 (docs.kie.ai/ai-agent/codex-cli):
 * `GET https://api.kie.ai/openai/v1/models` with `Authorization: Bearer`
 * (an `apikey` header is rejected) returns `.data[].id` and a richer
 * `.models[]` copy. Only non-secret qualification metadata is kept: exact
 * identifier, context window, reasoning levels and retrieval time. Provider
 * instructions and other listing fields are dropped. Errors carry a closed
 * code only, never the token, URL query or response body.
 */

export const KIE_OPENAI_BASE_URL = "https://api.kie.ai/openai/v1";
export const KIE_MODELS_URL = `${KIE_OPENAI_BASE_URL}/models`;
export const KIE_RESPONSES_URL = `${KIE_OPENAI_BASE_URL}/responses`;
/** Grok Responses endpoint (docs.kie.ai/market/grok/grok-4-7.md, retrieved 2026-10-06). */
export const KIE_GROK_RESPONSES_URL = "https://api.kie.ai/grok/v1/responses";

/**
 * The only endpoints a request (and the credential) may be sent to, each with its documented request layout
 * (route kie-responses.11b.5, owner approval 2026-10-06). INSTRUCTIONS_FIELD: the static prompt in the
 * documented `instructions` field and the synthetic JSON as the single user message. SEPARATE_USER_MESSAGES:
 * the Grok endpoint documents no `instructions` field and no system or developer role, so the static prompt
 * and the synthetic JSON travel as two separate user messages, in that order, and are never merged.
 */
export const KIE_ENDPOINT_LAYOUTS: Readonly<Record<string, "INSTRUCTIONS_FIELD" | "SEPARATE_USER_MESSAGES">> = Object.freeze({
  [KIE_RESPONSES_URL]: "INSTRUCTIONS_FIELD",
  [KIE_GROK_RESPONSES_URL]: "SEPARATE_USER_MESSAGES",
});

export type KieModelProvenance = "LISTED" | "DOCUMENTED_UNLISTED_EVALUATION_ONLY";

export type KieModelSnapshot = Readonly<{
  /** The exact identifier sent to Kie. */
  requestModelId: string;
  /**
   * The exact identifier required, byte-for-byte, in a completed response and recorded in audit and
   * evaluation evidence. Equal to the request identifier unless the owner approved an exact pair.
   */
  responseModelSnapshot: string;
  provenance: KieModelProvenance;
  endpoint: string;
  contextWindow: number | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: readonly string[];
  retrievedAt: string;
  documentationUrl: string | null;
}>;

/**
 * Owner authority amendment (2026-10-05): a model absent from the live listing
 * may be evaluated only when a current official per-model page documents its
 * exact identifier, endpoint, bearer authentication, non-streaming behaviour
 * and strict structured output. It is never pinned into a product bundle from
 * documentation status alone.
 */
export type KieDocumentedModel = Readonly<{
  requestModelId: string;
  responseModelSnapshot: string;
  provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY";
  endpoint: string;
  documentationUrl: string;
  documentedAt: string;
  supportedReasoningLevels: readonly string[];
  structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT";
  unsupportedParameters: readonly string[];
}>;

export const KIE_DOCUMENTED_MODELS: readonly KieDocumentedModel[] = Object.freeze([
  Object.freeze({
    requestModelId: "deepseek-v4-1-flash",
    // Owner-approved exact identity pair (2026-10-05): Kie answered this alias with this dated
    // snapshot (diagnostic call: HTTP 200 JSON, completed). Exact equality only; never a pattern.
    responseModelSnapshot: "deepseek-v4-1-flash-260910",
    provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
    endpoint: KIE_RESPONSES_URL,
    documentationUrl: "https://docs.kie.ai/market/deepseek-v4-1-flash.md",
    documentedAt: "2026-10-04",
    supportedReasoningLevels: Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
    structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT",
    // Documented as "not supported on this model and have no effect".
    unsupportedParameters: Object.freeze(["max_output_tokens", "temperature", "top_p"]),
  } as const),
  Object.freeze({
    requestModelId: "grok-4-7",
    // The expected exact identifier, equal to the request identifier until a live response is observed
    // (owner policy 2026-10-06). It is a pin, not an inference: a response without this exact `model`
    // value is rejected, and any other returned identifier is recorded only as evidence.
    responseModelSnapshot: "grok-4-7",
    provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
    endpoint: KIE_GROK_RESPONSES_URL,
    documentationUrl: "https://docs.kie.ai/market/grok/grok-4-7.md",
    documentedAt: "2026-10-06",
    supportedReasoningLevels: Object.freeze(["low", "medium", "high", "xhigh"]),
    structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT",
    // The page documents no unsupported parameter; only documented fields are ever sent.
    unsupportedParameters: Object.freeze([]),
  } as const),
]);

export type KieDiscoveryErrorCode = "MISSING_CONFIGURATION" | "AUTHENTICATION_FAILED" | "LISTING_UNAVAILABLE" | "LISTING_INVALID";

export class KieDiscoveryError extends Error {
  readonly name = "KieDiscoveryError";
  constructor(readonly code: KieDiscoveryErrorCode) {
    super(`Kie model discovery failed: ${code}`);
  }
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const level = z.union([z.string().regex(/^[a-z]{1,16}$/), z.object({ effort: z.string().regex(/^[a-z]{1,16}$/) }).passthrough()]);
const listingSchema = z
  .object({
    models: z.array(
      z
        .object({
          slug: z.string().regex(MODEL_ID),
          context_window: z.number().int().positive().nullable().optional(),
          default_reasoning_level: z.string().regex(/^[a-z]{1,16}$/).nullable().optional(),
          supported_reasoning_levels: z.array(level).max(16).optional(),
        })
        .passthrough(),
    ).max(500),
  })
  .passthrough();

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function discoverKieModels(options: { token: string; fetcher?: Fetcher; signal?: AbortSignal; now?: () => string }): Promise<readonly KieModelSnapshot[]> {
  const token = options.token.trim();
  if (token.length === 0) throw new KieDiscoveryError("MISSING_CONFIGURATION");
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(KIE_MODELS_URL, { method: "GET", cache: "no-store", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: options.signal });
  } catch {
    throw new KieDiscoveryError("LISTING_UNAVAILABLE");
  }
  if (response.status === 401 || response.status === 403) throw new KieDiscoveryError("AUTHENTICATION_FAILED");
  if (!response.ok) throw new KieDiscoveryError("LISTING_UNAVAILABLE");

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new KieDiscoveryError("LISTING_INVALID");
  }
  const parsed = listingSchema.safeParse(body);
  if (!parsed.success) throw new KieDiscoveryError("LISTING_INVALID");

  const retrievedAt = (options.now ?? (() => new Date().toISOString()))();
  const seen = new Set<string>();
  const snapshots: KieModelSnapshot[] = [];
  for (const entry of parsed.data.models) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    snapshots.push(
      Object.freeze({
        requestModelId: entry.slug,
        responseModelSnapshot: entry.slug,
        provenance: "LISTED",
        endpoint: KIE_RESPONSES_URL,
        contextWindow: entry.context_window ?? null,
        defaultReasoningLevel: entry.default_reasoning_level ?? null,
        supportedReasoningLevels: Object.freeze((entry.supported_reasoning_levels ?? []).map((value) => (typeof value === "string" ? value : value.effort))),
        retrievedAt,
        documentationUrl: null,
      }),
    );
  }
  return Object.freeze(snapshots);
}
