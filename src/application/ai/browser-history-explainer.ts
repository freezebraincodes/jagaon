import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import type { Instant } from "@/domain/shared/time";
import type { CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import type { RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import type { CarePreparationCommandPort, CarePreparationQueryPort, ExpectedHead } from "@/application/care-preparation/care-preparation-contracts";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import { createCareSummaryAiComposer, type CareSummaryAiOutcome } from "@/application/care-preparation/compose-care-summary-with-ai";
import { AI_ACTIVATION_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "./ai-activation-manifest";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import type { AiInvocationAuditPort } from "./ai-provider-port";
import type { AiLocale, AiTaskType } from "@/domain/ai";
import { createBrowserShellClient, INTERIM_FAIL_CLOSED_DISCLOSURE, type AiRemoteUseDecision, type AiRemoteUseDisclosure, type AiRemoteUseSession, type BrowserShellFetcher } from "./browser-shell-client";
import { createPatternExplainer, type PatternExplanation } from "./explain-pattern";

/**
 * Packet 11C Addendum B, Task B2b: the browser wiring of the Recorded-history explanation (B-boundary, D1). The app calls this once per
 * opened dataset runtime and passes the result to the history screen, so the explainer keeps one identity for the runtime's lifetime.
 *
 * It builds exactly ONE hybrid task service (the shipped activation manifest, the browser shell client behind the remote-use disclosure,
 * the runtime's local AI audit port) and ONE pattern explainer over the runtime's history query. Constructing it reads, writes and sends
 * nothing. Work happens only when the patient explicitly asks how a comparison was worked out (`explain`): each such request writes one
 * local audit row. With the shipped manifest every explanation is composed deterministically in the browser, nothing is sent, no
 * disclosure is asked and the result carries no AI source.
 *
 * Packet 11C Addendum B, Task B3: the app passes its in-memory disclosure session (`remoteUse`, one per app session). The screen asks
 * `disclosureRequired()` on the patient's action and, when it is true, shows the disclosure dialog BEFORE calling `explain`, so the
 * decision is made before the hybrid service and its timers start. `disclosureRequired()` is true only while EXPLAIN_PATTERN is
 * SYNTHETIC_REMOTE_ENABLED for the release profile and the session has not accepted; it is never true while NOT_ACTIVATED, and never
 * without a session (then the interim fail-closed disclosure applies and there is nothing to accept). `acceptDisclosure()` records the
 * session's acceptance (the dialog's primary action only). A cancelled dialog still explains, deterministically, with nothing sent.
 *
 * Only the history, care-preparation, audit and session ports are passed by the shipped app. The other dependencies are test seams (an
 * injected test manifest, a test-only disclosure, a fake fetcher, a fixed clock); the session takes precedence over the disclosure seam.
 *
 * Packet 11C Addendum B, Task B4b: `createBrowserAiAssistance` is the app's ONE AI wiring per opened runtime. The SAME hybrid service
 * (so the same browser shell client, session disclosure, per-request decline and audit port) serves the history explanation and the
 * care-summary AI wording (`composeCareSummaryWithAi` over the runtime's care-preparation ports). `createBrowserHistoryExplainer` is its
 * history half. With the shipped manifest the care wording is never `available()`, never asks the disclosure and never sends; the
 * preview screen does not show its action. A DETERMINISTIC hybrid result never creates a replacement snapshot (the use case replaces
 * only from a validated AI composition, and the runtime's care service re-validates it with `projectValidatedAiCareSummary`).
 */
export type BrowserHistoryExplainerDependencies = Readonly<{
  history: RecordedHistoryQueryPort;
  audit: AiInvocationAuditPort;
  remoteUse?: AiRemoteUseSession;
  manifest?: AiActivationManifest;
  disclosure?: AiRemoteUseDisclosure;
  fetcher?: BrowserShellFetcher;
  now?: () => Instant;
  monotonicMs?: () => number;
  requestId?: () => string;
  online?: () => boolean;
}>;

/** Packet 11C B4b: the runtime's care-preparation ports the care-summary wording reads and replaces through. */
export type BrowserAiAssistanceDependencies = BrowserHistoryExplainerDependencies &
  Readonly<{ carePreparation?: Readonly<{ query: CarePreparationQueryPort; commands: Pick<CarePreparationCommandPort, "replaceWithAiAssistedPreview"> }> }>;

/**
 * Packet 11C B4b: the care-summary preview's AI wording (structurally the preview screen's `CareSummaryAiWordingPort`).
 * - `available()`: DRAFT_CARE_PREPARATION_SUMMARY is SYNTHETIC_REMOTE_ENABLED for the release profile and the device is online. Never
 *   true with the shipped manifest. The screen adds the snapshot conditions (current, unapproved, current-template, deterministic).
 * - `disclosureRequired(current)`: true only when available, this session has not accepted, and the preview can be sent at all (an
 *   ineligible preview, e.g. more facts than one request may carry, sends nothing, so there is nothing to disclose). Reads nothing.
 * - `acceptDisclosure()`: the session's acceptance (the disclosure dialog's primary action only).
 * - `compose(...)`: one explicit request (one audit row whenever the hybrid service runs). `disclosure: "DECLINED"` marks a request
 *   made after the patient cancelled the disclosure: it composes deterministically, sends nothing and is audited REQUEST_CANCELLED.
 */
export type BrowserCareSummaryWording = Readonly<{
  available(): boolean;
  disclosureRequired(current: CareSummarySnapshotPayload): boolean;
  acceptDisclosure(): void;
  compose(input: { snapshotRef: ExpectedHead; locale: AiLocale; disclosure?: "DECLINED" }, signal?: AbortSignal): Promise<CareSummaryAiOutcome>;
}>;

export type BrowserAiAssistance = Readonly<{ history: BrowserHistoryExplainer; careSummary: BrowserCareSummaryWording | null }>;

export type BrowserHistoryExplainer = Readonly<{
  /**
   * Explains one comparison (the use case's `explain`). Packet 11C B4a: `disclosure: "DECLINED"` marks a request made after the patient
   * cancelled the disclosure: that request's remote-use decision is DECLINED (whatever the session says), so it composes
   * deterministically, sends nothing and is audited as REQUEST_CANCELLED. The decline belongs to that one request only.
   */
  explain(input: { factId: string; locale: AiLocale; disclosure?: "DECLINED" }, signal?: AbortSignal): Promise<PatternExplanation>;
  /** True only when the next explanation would use the remote route and this app session has not accepted the disclosure. */
  disclosureRequired(): boolean;
  /** Records this app session's acceptance of the disclosure (called by the dialog's primary action only). */
  acceptDisclosure(): void;
}>;

const deviceNow = () => new Date().toISOString() as Instant;
const deviceMonotonicMs = () => performance.now();
const newRequestId = () => crypto.randomUUID();
const browserOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

export function createBrowserHistoryExplainer(dependencies: BrowserHistoryExplainerDependencies): BrowserHistoryExplainer {
  return createBrowserAiAssistance(dependencies).history;
}

export function createBrowserAiAssistance(dependencies: BrowserAiAssistanceDependencies): BrowserAiAssistance {
  const now = dependencies.now ?? deviceNow;
  const manifest = dependencies.manifest ?? AI_ACTIVATION_MANIFEST;
  const online = dependencies.online ?? browserOnline;
  const requestId = dependencies.requestId ?? newRequestId;
  const session = dependencies.remoteUse ?? null;
  const disclosure = session?.disclosure ?? dependencies.disclosure ?? INTERIM_FAIL_CLOSED_DISCLOSURE;
  // Packet 11C B4a: the signals of the requests the patient declined. The hybrid service decides remote use with the request's own
  // signal, so a declined request answers DECLINED (and never ACCEPTED), and no other request is affected.
  const declined = new WeakSet<AbortSignal>();
  const perRequest: AiRemoteUseDisclosure = Object.freeze({
    decide: (signal: AbortSignal): Promise<AiRemoteUseDecision> => (declined.has(signal) ? Promise.resolve("DECLINED") : disclosure.decide(signal)),
  });
  /** The request's own signal, registered as declined when the patient cancelled the disclosure for it. */
  const requestSignal = (decline: "DECLINED" | undefined, signal: AbortSignal | undefined): AbortSignal | undefined => {
    if (decline !== "DECLINED") return signal;
    const own = signal ?? new AbortController().signal;
    declined.add(own);
    return own;
  };
  // ONE hybrid service for every flow of this runtime (Packet 11C B4b).
  const service = createAiHybridTaskService({
    releaseProfile: CURRENT_RELEASE_PROFILE,
    audit: dependencies.audit,
    now,
    monotonicMs: dependencies.monotonicMs ?? deviceMonotonicMs,
    manifest,
    provider: createBrowserShellClient({ disclosure: perRequest, fetcher: dependencies.fetcher }),
    online,
  });
  // Packet 11C B4a: never while offline either (the service would not send, so there is nothing to disclose).
  const remoteEnabled = (taskType: AiTaskType) => online() && resolveAiTaskActivation(taskType, CURRENT_RELEASE_PROFILE, manifest).state === "SYNTHETIC_REMOTE_ENABLED";
  const disclosurePending = (taskType: AiTaskType) => session !== null && !session.accepted() && remoteEnabled(taskType);
  const acceptDisclosure = () => session?.accept();

  const explainer = createPatternExplainer({ history: dependencies.history, execute: service.execute, now, requestId });
  const history: BrowserHistoryExplainer = Object.freeze({
    explain: (input: { factId: string; locale: AiLocale; disclosure?: "DECLINED" }, signal?: AbortSignal) =>
      explainer.explain({ factId: input.factId, locale: input.locale }, requestSignal(input.disclosure, signal)),
    disclosureRequired: () => disclosurePending("EXPLAIN_PATTERN"),
    acceptDisclosure,
  });

  const care = dependencies.carePreparation;
  if (!care) return Object.freeze({ history, careSummary: null });
  const composer = createCareSummaryAiComposer({ query: care.query, commands: care.commands, execute: service.execute, now, requestId });
  const careSummary: BrowserCareSummaryWording = Object.freeze({
    available: () => remoteEnabled("DRAFT_CARE_PREPARATION_SUMMARY"),
    // The eligibility check is the use case's own pure request builder over the snapshot alone; it reads, writes and sends nothing.
    disclosureRequired: (current: CareSummarySnapshotPayload) =>
      disclosurePending("DRAFT_CARE_PREPARATION_SUMMARY") && buildCareSummaryAiRequest({ current, requestId: requestId(), requestedAt: now() }).kind === "READY",
    acceptDisclosure,
    compose: (input: { snapshotRef: ExpectedHead; locale: AiLocale; disclosure?: "DECLINED" }, signal?: AbortSignal) =>
      composer.composeCareSummaryWithAi({ snapshotRef: input.snapshotRef, locale: input.locale }, requestSignal(input.disclosure, signal)),
  });
  return Object.freeze({ history, careSummary });
}
