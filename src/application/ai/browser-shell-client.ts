import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { shellTaskRequestSchema, type ShellTaskRequest } from "@/domain/ai";
import { decideRemoteUse } from "./ai-call-support";
import { PROVIDER_FAILURE_REASONS, type AiRemoteUseDecision, type AiRemoteUseDisclosure, type AiShellProviderPort, type ProviderFailureReason, type ProviderInvocationResult, type ProviderUsage } from "./ai-provider-port";
import { AI_SHELL_MAX_BODY_BYTES, AI_SHELL_ROUTE_PATH, aiShellRouteResponseSchema } from "./ai-shell-route-contract";
import { isApprovedShellTaskRequest } from "./language/shell-projector";

export type { AiRemoteUseDecision, AiRemoteUseDisclosure };

/**
 * Packet 11C Addendum B, Task B2b: the browser client of the value-blind shell route POST /api/ai/shell (B-boundary, D1, D2, D6).
 *
 * It implements the hybrid service's `AiShellProviderPort`. Per call, in order:
 * 1. The request is re-checked client-side with the strict `shellTaskRequestSchema` and `isApprovedShellTaskRequest` (approved glosses
 *    and headings only; no fact, value, date, question, period summary, source or reference) and the route's body cap. Anything else,
 *    including legacy detached-projector output, is refused here: no disclosure is asked and nothing is sent.
 * 2. Interim rule (owner approval 2026-10-08): remote use fails closed without an accepted disclosure. The injected disclosure is asked
 *    before EVERY send; anything but an explicit "ACCEPTED" (a refusal, an error, an unknown answer, an abort) ends the call with the
 *    closed `MISSING_CONFIGURATION` reason and nothing is sent. `INTERIM_FAIL_CLOSED_DISCLOSURE` never accepts and stays the default of
 *    any path without the session disclosure.
 *    Task B3: the client also exposes its disclosure as the port's `remoteUse`, so the hybrid service decides it once per request BEFORE
 *    the first attempt and any timer (an honest audit row when nothing is sent); the check here stays as a second, per-send guard. The
 *    app's disclosure is `createAiRemoteUseSession()`: one in-memory acceptance per app session, given only by the patient's acceptance
 *    of the disclosure dialog, which the screen shows before it asks for any explanation; it then answers at once, without asking again.
 * 3. One same-origin POST of the strictly parsed request to the relative route path: JSON, `cache: "no-store"`, redirects refused, and
 *    the caller's AbortSignal (the hybrid service's per-call timeout and the user's cancellation abort the request).
 * 4. The answer is parsed strictly with the shared route contract and mapped to a provider result: CANDIDATE -> COMPLETED (validated
 *    again by the service's full local gates before any use), STRUCTURALLY_REJECTED -> the typed rejection (D6), FAILED -> a closed
 *    provider failure reason, with the billed usage when the route reported it. A non-2xx status, a non-JSON or non-conforming body
 *    and a network error are closed failures; no technical text is ever surfaced.
 *
 * The client never retries (the hybrid service owns the single structural repair) and carries no credential, endpoint, provider
 * setting or caller-chosen model. `providerModel` names the D2 route identity for the local audit only; it is not a runtime-bundle
 * pin (runtime bundles keep `modelSnapshot: null`) and activates nothing.
 */

/** D2: the route's fixed identity (Direct DeepSeek deepseek-flash), recorded in the local audit row only. */
export const BROWSER_SHELL_CLIENT_PROVIDER_MODEL: Readonly<{ providerKey: string; modelSnapshot: string }> = Object.freeze({ providerKey: "deepseek", modelSnapshot: "deepseek-flash" });

/** The interim fail-closed disclosure: remote use is never accepted. The default of any path without the session disclosure (B3). */
export const INTERIM_FAIL_CLOSED_DISCLOSURE: AiRemoteUseDisclosure = Object.freeze({ decide: async (): Promise<AiRemoteUseDecision> => "NOT_ACCEPTED" });

/**
 * Packet 11C Addendum B, Task B3 (coordinator ruling: once per app session). `disclosure` answers NOT_ACCEPTED until `accept()` is
 * called, then ACCEPTED for the rest of the session, immediately (it never waits, so it is never a wait inside the hybrid timers).
 * Only the disclosure dialog's primary action calls `accept()`. In memory only: nothing is persisted, so a reload is a new session.
 */
export type AiRemoteUseSession = Readonly<{ disclosure: AiRemoteUseDisclosure; accepted(): boolean; accept(): void }>;

export function createAiRemoteUseSession(): AiRemoteUseSession {
  let accepted = false;
  return Object.freeze({
    disclosure: Object.freeze({ decide: async (): Promise<AiRemoteUseDecision> => (accepted ? "ACCEPTED" : "NOT_ACCEPTED") }),
    accepted: () => accepted,
    accept: () => {
      accepted = true;
    },
  });
}

export type BrowserShellFetcher = (input: string, init: RequestInit) => Promise<Response>;

/** The closed reason for a call ended because remote use was not accepted (no send happened). */
const NOT_ACCEPTED_REASON: ProviderFailureReason = "MISSING_CONFIGURATION";
/** The closed reason for a request the boundary refuses (client-side check or a 4xx from the route). */
const REFUSED_REASON: ProviderFailureReason = "PROVIDER_REJECTED";
/** The largest route answer read; a valid answer is a few kilobytes. */
const MAX_RESPONSE_CHARS = 65_536;

const failed = (reason: ProviderFailureReason, usage?: ProviderUsage): ProviderInvocationResult => (usage ? { kind: "FAILED", reason, usage } : { kind: "FAILED", reason });

function statusReason(status: number): ProviderFailureReason {
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  return status >= 400 && status < 500 ? REFUSED_REASON : "PROVIDER_FAILED";
}

export function createBrowserShellClient(options: { disclosure: AiRemoteUseDisclosure; fetcher?: BrowserShellFetcher }): AiShellProviderPort {
  // The global network primitive is bound lazily, per call; nothing is sent at construction.
  const fetcher: BrowserShellFetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  return Object.freeze({
    providerModel: BROWSER_SHELL_CLIENT_PROVIDER_MODEL,
    // Task B3: decided by the hybrid service before the first attempt (and re-checked below before each send).
    remoteUse: options.disclosure,
    async invoke(input: ShellTaskRequest, signal: AbortSignal): Promise<ProviderInvocationResult> {
      const parsed = shellTaskRequestSchema.safeParse(input);
      if (!parsed.success || !isApprovedShellTaskRequest(parsed.data)) return failed(REFUSED_REASON);
      const body = JSON.stringify(parsed.data);
      if (new TextEncoder().encode(body).byteLength > AI_SHELL_MAX_BODY_BYTES) return failed(REFUSED_REASON);

      if ((await decideRemoteUse(options.disclosure, signal)) !== "ACCEPTED" || signal.aborted) return failed(NOT_ACCEPTED_REASON);

      let response: Response;
      try {
        response = await fetcher(AI_SHELL_ROUTE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store", redirect: "error", signal });
      } catch {
        return failed("TRANSPORT_FAILED");
      }
      if (!response.ok) return failed(statusReason(response.status));
      if (!/^application\/json(\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return failed("PROVIDER_FAILED");
      let text: string;
      try {
        text = await response.text();
      } catch {
        return failed("TRANSPORT_FAILED");
      }
      if (text.length > MAX_RESPONSE_CHARS) return failed("PROVIDER_FAILED");
      let value: unknown;
      try {
        value = toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: MAX_RESPONSE_CHARS }));
      } catch {
        return failed("PROVIDER_FAILED");
      }
      const answer = aiShellRouteResponseSchema.safeParse(value);
      if (!answer.success) return failed("PROVIDER_FAILED");
      const route = answer.data;
      if (route.kind === "CANDIDATE") return { kind: "COMPLETED", candidate: route.candidate, usage: route.usage, retention: route.retention };
      if (route.kind === "STRUCTURALLY_REJECTED") return { kind: "STRUCTURALLY_REJECTED", reason: route.reason, repairable: route.repairable, usage: route.usage, retention: route.retention };
      const reason = (PROVIDER_FAILURE_REASONS as readonly string[]).includes(route.reason) ? (route.reason as ProviderFailureReason) : "PROVIDER_FAILED";
      return failed(reason, route.usage);
    },
  });
}
