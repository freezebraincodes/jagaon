import type { AiInvocationAuditRow, ProviderTaskRequest, ShellTaskRequest } from "@/domain/ai";
import type { AiShellRouteRefusalReason } from "./ai-shell-route-contract";

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
export type ProviderUsage = Readonly<{ inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null; credits?: number | null; basis?: ProviderUsageBasis }>;
/**
 * Packet 11C Addendum C (C5): what a usage figure is. REPORTED (the default when absent) is the provider's own report; UPPER_BOUND is
 * the pre-send upper bound of a potentially billed call whose usage is missing or unreadable (counted, never treated as zero spend).
 */
export type ProviderUsageBasis = "REPORTED" | "UPPER_BOUND";

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
   * `usage` (Packet 11C B2b; widened in Addendum C, C5): present on every failure that follows a potentially billed transmission, so the
   * hybrid service counts that spend: the provider-reported usage when the provider reported it, else the call's pre-send upper bound
   * (basis UPPER_BOUND). Absent exactly when nothing was transmitted (a refused, unconfigured or not-accepted call), i.e. nothing billed.
   * `refusal` (Packet 11C Addendum C, C1): the server shell route's closed REFUSED reason (decided before any provider call; the browser
   * client sets it, with reason PROVIDER_REJECTED and no usage). The hybrid service audits it as that audit-only outcome code.
   */
  | Readonly<{ kind: "FAILED"; reason: ProviderFailureReason; usage?: ProviderUsage; refusal?: AiShellRouteRefusalReason }>;

export type AiProviderPort = Readonly<{
  /** The exact provider and model snapshot this port is pinned to, recorded in the local audit. */
  providerModel: Readonly<{ providerKey: string; modelSnapshot: string }>;
  invoke(input: ProviderTaskRequest, signal: AbortSignal): Promise<ProviderInvocationResult>;
}>;

/**
 * "DECLINED" (Packet 11C B4a) is the patient's explicit Cancel of the disclosure for this request: like NOT_ACCEPTED nothing is sent, but
 * the request is audited as REMOTE_USE_DECLINED (Packet 11C Addendum C, C5: an audit-only code of ai-invocation-audit.11c.2; its closed
 * fallback reason stays REQUEST_CANCELLED); NOT_ACCEPTED (no acceptance exists for this request, e.g. no decision was given for it, its
 * decision already ended, or the interim fail-closed path) keeps the closed reason MISSING_CONFIGURATION and is audited as
 * REMOTE_USE_NOT_ACCEPTED (Packet 11C Addendum C, C3: an audit-only code of ai-invocation-audit.11c.2).
 */
export type AiRemoteUseDecision = "ACCEPTED" | "NOT_ACCEPTED" | "DECLINED";
/**
 * The patient's remote-use disclosure (Packet 11C B2b interim rule; Task B3). It sees the request's signal so it can stop when the
 * request ends. Anything but an explicit "ACCEPTED" (a refusal, a decline, an error, an unknown answer, an abort) means nothing is sent.
 * Packet 11C Addendum C, C3: the signal is the explicit request's own decision token; the browser's per-request decisions answer for
 * that one request only (`createAiRemoteUseDecisions`).
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
  /**
   * `signal` is the per-call signal (timeouts and cancellation). `decisionToken` (Packet 11C Addendum C, C3) is passed only to a provider
   * with `remoteUse`: the explicit request's own decision token (the signal its remote-use decision was made with), identical for every
   * attempt of that request, so the provider's per-send re-check reads THAT request's decision (the repair attempt included) and never
   * prompts. It never reaches a request body. The server-side adapters ignore it.
   */
  invoke(input: ShellTaskRequest, signal: AbortSignal, decisionToken?: AbortSignal): Promise<ProviderInvocationResult>;
}>;

/** Accepts already-minimised audit metadata only, never the request or provider result. */
export type AiInvocationAuditPort = Readonly<{
  append(row: AiInvocationAuditRow): Promise<void>;
}>;
