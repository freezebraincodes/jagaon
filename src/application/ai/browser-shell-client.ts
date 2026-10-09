import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { shellTaskRequestSchema, type ShellTaskRequest } from "@/domain/ai";
import { decideRemoteUse } from "./ai-call-support";
import { PROVIDER_FAILURE_REASONS, type AiRemoteUseDecision, type AiRemoteUseDisclosure, type AiShellProviderPort, type ProviderFailureReason, type ProviderInvocationResult, type ProviderUsage } from "./ai-provider-port";
import { AI_SHELL_ACCESS_HEADER, AI_SHELL_MAX_BODY_BYTES, AI_SHELL_ROUTE_PATH, aiShellRouteResponseSchema, shellRouteCallUpperBound, type AiShellRouteRefusalReason } from "./ai-shell-route-contract";
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
 *    any path without the per-request decisions (C3).
 *    Task B3: the client also exposes its disclosure as the port's `remoteUse`, so the hybrid service decides it once per request BEFORE
 *    the first attempt and any timer (an honest audit row when nothing is sent); the check here stays as a second, per-send guard.
 *    Packet 11C Addendum C, Task C3: the app's disclosure is `createAiRemoteUseDecisions().disclosure`: an acceptance belongs to ONE
 *    explicit request (its decision token, given only by the patient's acceptance of the dialog the screen shows for that request), and
 *    the per-send guard reads that request's token (`invoke`'s `decisionToken`), so the repair never asks the patient again and a later request does
 *    not inherit it. This replaces the B3 once-per-app-session acceptance.
 * 3. One same-origin POST of the strictly parsed request to the relative route path: JSON, `cache: "no-store"`, redirects refused, and
 *    the caller's AbortSignal (the hybrid service's per-call timeout and the user's cancellation abort the request).
 * 4. The answer is parsed strictly with the shared route contract and mapped to a provider result: CANDIDATE -> COMPLETED (validated
 *    again by the service's full local gates before any use), STRUCTURALLY_REJECTED -> the typed rejection (D6), FAILED -> a closed
 *    provider failure reason, with the billed usage when the route reported it. A non-2xx status, a non-JSON or non-conforming body
 *    and a network error are closed failures; no technical text is ever surfaced.
 *    Packet 11C Addendum C (C1): a 403 `REFUSED` answer (the route's class check, before any credential read) is the closed
 *    PROVIDER_REJECTED with its `refusal` (REQUEST_CLASS_NOT_QUALIFIED) and no usage, so the service audits it truthfully.
 *    Packet 11C Addendum C (C6): the same for every route refusal (switch, origin, access, spend), passed on with the route's
 *    `notSentToProvider` marker so the service never counts the refused call as an attempt. The POST carries the entered demo passcode
 *    as one request header (`accessPasscode`; in memory only, never in the body); the browser adds Origin and Sec-Fetch-Site itself.
 *
 * The client never retries (the hybrid service owns the single structural repair) and carries no credential, endpoint, provider
 * setting or caller-chosen model. `providerModel` names the D2 route identity for the local audit only; it is not a runtime-bundle
 * pin (runtime bundles keep `modelSnapshot: null`) and activates nothing.
 */

/** D2: the route's fixed identity (Direct DeepSeek deepseek-flash), recorded in the local audit row only. */
export const BROWSER_SHELL_CLIENT_PROVIDER_MODEL: Readonly<{ providerKey: string; modelSnapshot: string }> = Object.freeze({ providerKey: "deepseek", modelSnapshot: "deepseek-flash" });

/** The interim fail-closed disclosure: remote use is never accepted. The default of any path without the per-request decisions (C3). */
export const INTERIM_FAIL_CLOSED_DISCLOSURE: AiRemoteUseDisclosure = Object.freeze({ decide: async (): Promise<AiRemoteUseDecision> => "NOT_ACCEPTED" });

/** The patient's answer to the disclosure shown for ONE explicit request (Packet 11C Addendum C, C3). */
export type AiRemoteUseRequestDecision = "ACCEPTED" | "DECLINED";

/**
 * Packet 11C Addendum C, Task C3 (owner decision: "Disclosure acceptance is per explicit request; one permitted structural repair shares
 * that request's decision. A new request needs a new decision."). Replaces the B3 once-per-app-session acceptance.
 *
 * - Token: a decision is bound to ONE explicit request's decision token, its AbortSignal, which the screen creates for the request the
 *   patient's action started (a fresh token is made when a decision comes without a signal). The token's decision is what `disclosure`
 *   answers for it: ACCEPTED, DECLINED, or NOT_ACCEPTED for anything else. It answers at once and never asks the patient (the screen asks the
 *   patient BEFORE the request starts), so it is never a wait inside the hybrid timers.
 * - Lifetime: `run(decision, signal, request)` binds the decision to the token for exactly that request's run. The hybrid service reads
 *   it once before any attempt or timer; the client re-reads it (never asking again) before each send, the single structural repair
 *   included. An acceptance ends when the request settles (also on a failure) and whenever its token aborts (a new click, Retry, locale,
 *   period or view change, or unmount abort the screen's request), so it never covers a later request, a reused token, another token
 *   or the other flow.
 * - One decision per token: a second request on a token that already carried a decision never gets an acceptance (a live acceptance on a
 *   reused token ends for both requests); a decline stays DECLINED for that token (B5: fails safe). Only the two exact decisions count.
 * - In memory only: nothing is persisted or shared between instances.
 */
export type AiRemoteUseDecisions = Readonly<{
  disclosure: AiRemoteUseDisclosure;
  run<T>(decision: AiRemoteUseRequestDecision | undefined, signal: AbortSignal | undefined, request: (token: AbortSignal | undefined) => Promise<T>): Promise<T>;
}>;

export function createAiRemoteUseDecisions(): AiRemoteUseDecisions {
  const decisions = new WeakMap<AbortSignal, AiRemoteUseRequestDecision | "ENDED">();
  const disclosure: AiRemoteUseDisclosure = Object.freeze({
    decide: async (token: AbortSignal): Promise<AiRemoteUseDecision> => {
      const decision = decisions.get(token);
      if (decision === "DECLINED") return "DECLINED";
      return decision === "ACCEPTED" && !token.aborted ? "ACCEPTED" : "NOT_ACCEPTED";
    },
  });
  async function run<T>(decision: AiRemoteUseRequestDecision | undefined, signal: AbortSignal | undefined, request: (token: AbortSignal | undefined) => Promise<T>): Promise<T> {
    const given = decision === "ACCEPTED" || decision === "DECLINED" ? decision : undefined;
    if (given === undefined) {
      // A request without a decision never inherits one: a token whose acceptance is still live (reused) loses it.
      if (signal && decisions.get(signal) === "ACCEPTED") decisions.set(signal, "ENDED");
      return request(signal);
    }
    const token = signal ?? new AbortController().signal;
    const previous = decisions.get(token);
    decisions.set(token, given === "DECLINED" || previous === "DECLINED" ? "DECLINED" : previous === undefined ? "ACCEPTED" : "ENDED");
    try {
      return await request(token);
    } finally {
      if (decisions.get(token) === "ACCEPTED") decisions.set(token, "ENDED");
    }
  }
  return Object.freeze({ disclosure, run });
}

export type BrowserShellFetcher = (input: string, init: RequestInit) => Promise<Response>;

/** The closed reason for a call ended because remote use was not accepted (no send happened). */
const NOT_ACCEPTED_REASON: ProviderFailureReason = "MISSING_CONFIGURATION";
/** The closed reason for a request the boundary refuses (client-side check or a 4xx from the route). */
const REFUSED_REASON: ProviderFailureReason = "PROVIDER_REJECTED";
/** The largest route answer read; a valid answer is a few kilobytes. */
const MAX_RESPONSE_CHARS = 65_536;

const failed = (reason: ProviderFailureReason, usage?: ProviderUsage): ProviderInvocationResult => (usage ? { kind: "FAILED", reason, usage } : { kind: "FAILED", reason });
/**
 * C6 fix round 1 (brief item 5, C5 carry): an answer decided before the provider call (the client's own refusals before the POST, any
 * 4xx from the route, a route FAILED carrying the marker): the closed reason with `notSentToProvider: true` and never usage, so the
 * hybrid service records no attempt for it.
 */
const notSent = (reason: ProviderFailureReason): ProviderInvocationResult => ({ kind: "FAILED", reason, notSentToProvider: true });

function statusReason(status: number): ProviderFailureReason {
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  return status >= 400 && status < 500 ? REFUSED_REASON : "PROVIDER_FAILED";
}

/**
 * Packet 11C Addendum C (C1): a 403 is the route's refusal before any credential read or provider call (nothing billed, no usage). A
 * readable `REFUSED` body names its closed refusal (REQUEST_CLASS_NOT_QUALIFIED), which the hybrid service audits; anything else is the
 * plain closed refusal.
 */
async function refusedByRoute(response: Response, onRefusal: ((reason: AiShellRouteRefusalReason) => void) | undefined): Promise<ProviderInvocationResult> {
  try {
    if (!/^application\/json(\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return notSent(REFUSED_REASON);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) return notSent(REFUSED_REASON);
    const answer = aiShellRouteResponseSchema.safeParse(toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: MAX_RESPONSE_CHARS })));
    if (!answer.success || answer.data.kind !== "REFUSED") return notSent(REFUSED_REASON);
    const refusal = answer.data.reason;
    // Packet 11C Addendum C (C6): the wiring learns the closed code only (e.g. the switch is off); a throwing listener changes nothing.
    try {
      onRefusal?.(refusal);
    } catch {
      // ignored
    }
    return { kind: "FAILED", reason: REFUSED_REASON, refusal, notSentToProvider: true };
  } catch {
    return notSent(REFUSED_REASON);
  }
}

/** A passcode the route could accept as a header value: 1 to 128 visible ASCII characters. Anything else is not sent. */
const SENDABLE_PASSCODE = /^[\x21-\x7e]{1,128}$/;
function passcodeHeader(read: (() => string | null) | undefined): Record<string, string> {
  try {
    const value = read?.();
    return typeof value === "string" && SENDABLE_PASSCODE.test(value) ? { [AI_SHELL_ACCESS_HEADER]: value } : {};
  } catch {
    return {};
  }
}

/**
 * `accessPasscode` (Packet 11C Addendum C, C6): reads the demo passcode the person entered, held in the app's memory only (never
 * persisted); read once per POST and sent only as the `x-jagaon-demo-passcode` request header, never in the body. `onRefusal` (C6): told
 * the closed code of each route REFUSED (so the wiring can learn that the server switch is off, or forget a passcode the route denied).
 */
/**
 * `onPost` (owner UI decision U12, 2026-10-09): told, right before each POST leaves the browser, the decision token of the explicit
 * request it belongs to (the same token for its single repair), so the wiring knows a remote request was actually attempted. It never
 * sees or changes the request; a throwing listener changes nothing.
 */
export function createBrowserShellClient(options: { disclosure: AiRemoteUseDisclosure; fetcher?: BrowserShellFetcher; accessPasscode?: () => string | null; onRefusal?: (reason: AiShellRouteRefusalReason) => void; onPost?: (decisionToken: AbortSignal) => void }): AiShellProviderPort {
  // The global network primitive is bound lazily, per call; nothing is sent at construction.
  const fetcher: BrowserShellFetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  return Object.freeze({
    providerModel: BROWSER_SHELL_CLIENT_PROVIDER_MODEL,
    // Task B3: decided by the hybrid service before the first attempt (and re-checked below before each send).
    remoteUse: options.disclosure,
    async invoke(input: ShellTaskRequest, signal: AbortSignal, decisionToken?: AbortSignal): Promise<ProviderInvocationResult> {
      const parsed = shellTaskRequestSchema.safeParse(input);
      if (!parsed.success || !isApprovedShellTaskRequest(parsed.data)) return notSent(REFUSED_REASON);
      const body = JSON.stringify(parsed.data);
      if (new TextEncoder().encode(body).byteLength > AI_SHELL_MAX_BODY_BYTES) return notSent(REFUSED_REASON);

      // Packet 11C Addendum C (C3): the per-send re-check reads the explicit request's own decision (its token, the same for the repair
      // attempt), never a new question to the patient; without a token the per-call signal is asked, which no per-request decision covers.
      const token = decisionToken ?? signal;
      if ((await decideRemoteUse(options.disclosure, token)) !== "ACCEPTED" || signal.aborted || token.aborted) return notSent(NOT_ACCEPTED_REASON);

      // Packet 11C Addendum C (C5): from the POST on, the route may have made a billed provider call. A route refusal (4xx) was decided
      // before any provider call (nothing billed); any other answer without a readable route usage counts this request's pre-send upper
      // bound, never zero. A readable FAILED answer carries the route's own usage (reported or its bound), or none when nothing was called.
      const unreadable = (reason: ProviderFailureReason) => failed(reason, shellRouteCallUpperBound(parsed.data));
      let response: Response;
      try {
        options.onPost?.(token);
      } catch {
        // ignored: the listener only observes
      }
      try {
        response = await fetcher(AI_SHELL_ROUTE_PATH, { method: "POST", headers: { "content-type": "application/json", ...passcodeHeader(options.accessPasscode) }, body, cache: "no-store", redirect: "error", signal });
      } catch {
        return unreadable("TRANSPORT_FAILED");
      }
      if (response.status === 403) return refusedByRoute(response, options.onRefusal);
      // C6 fix round 1: a 4xx is a refusal before any provider call (marked not sent); a 5xx may follow a call (the upper bound counts).
      if (!response.ok) return response.status >= 400 && response.status < 500 ? notSent(statusReason(response.status)) : unreadable(statusReason(response.status));
      if (!/^application\/json(\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return unreadable("PROVIDER_FAILED");
      let text: string;
      try {
        text = await response.text();
      } catch {
        return unreadable("TRANSPORT_FAILED");
      }
      if (text.length > MAX_RESPONSE_CHARS) return unreadable("PROVIDER_FAILED");
      let value: unknown;
      try {
        value = toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: MAX_RESPONSE_CHARS }));
      } catch {
        return unreadable("PROVIDER_FAILED");
      }
      const answer = aiShellRouteResponseSchema.safeParse(value);
      if (!answer.success) return unreadable("PROVIDER_FAILED");
      const route = answer.data;
      if (route.kind === "CANDIDATE") return { kind: "COMPLETED", candidate: route.candidate, usage: route.usage, retention: route.retention };
      if (route.kind === "STRUCTURALLY_REJECTED") return { kind: "STRUCTURALLY_REJECTED", reason: route.reason, repairable: route.repairable, usage: route.usage, retention: route.retention };
      // Packet 11C Addendum C (C1): REFUSED is a 403 answer only; with any other status it is a non-conforming answer after the POST.
      if (route.kind === "REFUSED") return unreadable("PROVIDER_FAILED");
      const reason = (PROVIDER_FAILURE_REASONS as readonly string[]).includes(route.reason) ? (route.reason as ProviderFailureReason) : "PROVIDER_FAILED";
      // C6 fix round 1: the route's own not-sent marker is passed on (the contract never pairs it with usage).
      if (route.notSentToProvider === true && route.usage === undefined) return notSent(reason);
      return failed(reason, route.usage);
    },
  });
}
