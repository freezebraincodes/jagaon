import type { AiInvocationAuditRow, ProviderTaskRequest, ShellTaskRequest } from "@/domain/ai";

/**
 * Packet 11A provider-neutral ports (ai-system-spec Sections 7, 12). A provider
 * receives only the detached provider payload and an abort signal; it never
 * sees a request id, profile, instant or local source. 11A ships no provider
 * implementation: the adapter, credential and route arrive with 11B.
 */

export const PROVIDER_FAILURE_REASONS = Object.freeze([
  "MISSING_CONFIGURATION",
  "TRANSPORT_FAILED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REJECTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_FAILED",
  "OPERATIONAL_SPEND_LOCKED",
] as const);
export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];

/**
 * `credits` is the provider's own reported consumption (Kie `credits_consumed`). It is not a USD
 * amount, so it never fills the audit's `costMicroUsd`; evaluation reports carry it separately.
 */
export type ProviderUsage = Readonly<{ inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null; credits?: number | null }>;

/**
 * Closed provider-side retention result for a completed response (Packet 11B
 * retention pass). A closed code only, never response content; it is not part
 * of the audit row or any client-facing body.
 */
export type ProviderRetentionResult = "CONFIRMED_NOT_STORED" | "PROVIDER_REPORTED_STORED" | "RETENTION_UNCONFIRMED";

/** `candidate` is untrusted: raw text or parsed JSON that the validator alone may accept. */
export type ProviderInvocationResult =
  | Readonly<{
      kind: "COMPLETED";
      candidate: unknown;
      usage: ProviderUsage;
      /** The model identifier the provider reported, if any. */
      responseModel?: string | null;
      /** Absent means unconfirmed: remote use requires CONFIRMED_NOT_STORED. */
      retention?: ProviderRetentionResult;
    }>
  | Readonly<{ kind: "FAILED"; reason: ProviderFailureReason }>;

export type AiProviderPort = Readonly<{
  /** The exact provider and model snapshot this port is pinned to, recorded in the local audit. */
  providerModel: Readonly<{ providerKey: string; modelSnapshot: string }>;
  invoke(input: ProviderTaskRequest, signal: AbortSignal): Promise<ProviderInvocationResult>;
}>;

/** The hybrid layer's port: it receives only the value-blind shell request and an abort signal (Packet 11B.6). */
export type AiShellProviderPort = Readonly<{
  providerModel: Readonly<{ providerKey: string; modelSnapshot: string }>;
  invoke(input: ShellTaskRequest, signal: AbortSignal): Promise<ProviderInvocationResult>;
}>;

/** Accepts already-minimised audit metadata only, never the request or provider result. */
export type AiInvocationAuditPort = Readonly<{
  append(row: AiInvocationAuditRow): Promise<void>;
}>;
