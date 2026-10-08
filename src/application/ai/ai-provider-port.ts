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

/**
 * Packet 11C Addendum B, Task B2a (D6): the closed reasons a server shell gate (validateShellCandidate, S1–S7b) may give for a shell
 * candidate it rejected. Exactly the shell validator's reasons; every one is an AiReasonCode. Only SCHEMA_INVALID is ever repairable.
 */
export const SHELL_STRUCTURAL_REJECTION_REASONS = Object.freeze([
  "SCHEMA_INVALID",
  "LOCALE_INVALID",
  "MODEL_ABSTAINED",
  "REFERENCE_MISMATCH",
  "OUTPUT_BUDGET_EXCEEDED",
  "FACT_FIDELITY_FAILED",
  "CLINICAL_MEANING_VIOLATION",
  "AUTHORITY_BOUNDARY_VIOLATION",
] as const);
export type ShellStructuralRejectionReason = (typeof SHELL_STRUCTURAL_REJECTION_REASONS)[number];

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
  /**
   * D6: a completed (billed) shell candidate that the server shell route rejected at its value-blind shell gates. The candidate itself
   * never leaves the server. The hybrid service handles it exactly like its own shell-gate rejection: the usage is counted, and at most
   * one structural repair is made, only for a repairable SCHEMA_INVALID within maxAttempts. The direct provider adapters never return it.
   */
  | Readonly<{ kind: "STRUCTURALLY_REJECTED"; reason: ShellStructuralRejectionReason; repairable: boolean; usage: ProviderUsage; retention?: ProviderRetentionResult }>
  /**
   * `usage` (Packet 11C B2b): present only when a completed, billed response was refused after completion (the shell route's retention
   * refusal), so the hybrid service still counts that spend. Absent on every other failure.
   */
  | Readonly<{ kind: "FAILED"; reason: ProviderFailureReason; usage?: ProviderUsage }>;

export type AiProviderPort = Readonly<{
  /** The exact provider and model snapshot this port is pinned to, recorded in the local audit. */
  providerModel: Readonly<{ providerKey: string; modelSnapshot: string }>;
  invoke(input: ProviderTaskRequest, signal: AbortSignal): Promise<ProviderInvocationResult>;
}>;

/**
 * "DECLINED" (Packet 11C B4a) is the patient's explicit Cancel of the disclosure for this request: like NOT_ACCEPTED nothing is sent, but
 * the request is audited as REQUEST_CANCELLED (no audit-schema change); NOT_ACCEPTED (no acceptance exists, e.g. the interim fail-closed
 * path) stays MISSING_CONFIGURATION.
 */
export type AiRemoteUseDecision = "ACCEPTED" | "NOT_ACCEPTED" | "DECLINED";
/**
 * The patient's remote-use disclosure (Packet 11C B2b interim rule; Task B3). It sees the request's signal so it can stop when the
 * request ends. Anything but an explicit "ACCEPTED" (a refusal, a decline, an error, an unknown answer, an abort) means nothing is sent.
 */
export type AiRemoteUseDisclosure = Readonly<{ decide(signal: AbortSignal): Promise<AiRemoteUseDecision> }>;

/** The hybrid layer's port: it receives only the value-blind shell request and an abort signal (Packet 11B.6). */
export type AiShellProviderPort = Readonly<{
  providerModel: Readonly<{ providerKey: string; modelSnapshot: string }>;
  /**
   * Packet 11C Addendum B, Task B3: a provider that needs the patient's remote-use disclosure (the browser shell client) carries it here.
   * The hybrid service decides it once per request, after every local check and BEFORE the first attempt and any timer; a request that
   * is not accepted is never sent and its audit row records no attempt, provider model, source revision or usage. The provider also
   * re-checks it before each send. The server-side adapters carry none.
   */
  remoteUse?: AiRemoteUseDisclosure;
  invoke(input: ShellTaskRequest, signal: AbortSignal): Promise<ProviderInvocationResult>;
}>;

/** Accepts already-minimised audit metadata only, never the request or provider result. */
export type AiInvocationAuditPort = Readonly<{
  append(row: AiInvocationAuditRow): Promise<void>;
}>;
