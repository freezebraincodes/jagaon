import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import type { Instant } from "@/domain/shared/time";
import type { CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import type { RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import type { CarePreparationCommandPort, CarePreparationQueryPort, ExpectedHead } from "@/application/care-preparation/care-preparation-contracts";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import { createCareSummaryAiComposer, type CareSummaryAiOutcome } from "@/application/care-preparation/compose-care-summary-with-ai";
import { AI_ACTIVATION_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "./ai-activation-manifest";
import { resolveAiHybridBundle } from "./ai-hybrid-runtime-bundles";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import type { AiInvocationAuditPort } from "./ai-provider-port";
import { projectShellTaskRequest } from "./language/shell-projector";
import { planSlots } from "./language/slot-planner";
import { SHIPPED_REQUEST_CLASS_GATE, type AiRequestClassGate } from "./request-class-qualification";
import type { AiLocale, AiTaskRequest, ShellTask } from "@/domain/ai";
import { createAiRemoteUseDecisions, createBrowserShellClient, type AiRemoteUseRequestDecision, type BrowserShellFetcher } from "./browser-shell-client";
import { buildSourceBackedExplainRequest } from "./explain-pattern-request";
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
 * Packet 11C Addendum C, Task C3 (owner decision: "Disclosure acceptance is per explicit request; one permitted structural repair shares
 * that request's decision. A new request needs a new decision."), replacing the B3 once-per-app-session acceptance:
 * - The screen asks `disclosureRequired(...)` for the ONE request the patient's action starts and, when it is true, shows the disclosure
 *   BEFORE calling `explain` / `compose`, so the decision is made before the hybrid service and its timers start. Its answer travels with
 *   that request only (`disclosure: "ACCEPTED" | "DECLINED"`) and is bound to the request's own signal, its decision token
 *   (`createAiRemoteUseDecisions`): the service reads it once before any attempt, the single structural repair re-reads it without a
 *   prompt, and it ends when that request settles or its signal aborts (the screens abort on a new click, Retry, locale, period or view
 *   change and unmount). A request without its own decision is never sent (audited REMOTE_USE_NOT_ACCEPTED); an acceptance in one flow
 *   never covers the other flow or a later request. There is no session, no injectable disclosure and no other way to accept.
 * - The disclosure (and the care AI action) is offered only when a remote attempt could actually happen for THAT request: the task is
 *   SYNTHETIC_REMOTE_ENABLED for the release profile, the device is online, the server-side remote switch is not known to be off
 *   (`remoteSwitchKnownOff`, pluggable for C6; absent = not known off) and the request's own projected class is QUALIFIED (C1). History:
 *   the request built for that comparison and locale (one local read of the comparison's source projection; replaces C1's task-level
 *   `anyAdmissible`). Care: that preview's own request. With the shipped manifest and the all-PENDING records it is never offered.
 *
 * Only the history, care-preparation and audit ports are passed by the shipped app. The other dependencies are test seams (an injected
 * test manifest, a fake fetcher, a fixed clock, a test-only request-class gate, a remote switch signal).
 *
 * Packet 11C Addendum B, Task B4b: `createBrowserAiAssistance` is the app's ONE AI wiring per opened runtime. The SAME hybrid service
 * (so the same browser shell client, per-request decisions and audit port) serves the history explanation and the care-summary AI
 * wording (`composeCareSummaryWithAi` over the runtime's care-preparation ports). `createBrowserHistoryExplainer` is its history half.
 * With the shipped manifest the care wording is never `available()`, never asks the disclosure and never sends; the preview screen does
 * not show its action. A DETERMINISTIC hybrid result never creates a replacement snapshot (the use case replaces only from a validated AI
 * composition, and the runtime's care service re-validates it with `projectValidatedAiCareSummary`).
 *
 * Packet 11C Addendum C, Task C1: the one hybrid service gets the request-class gate (shipped: all PENDING, so every request composes
 * deterministically before any disclosure or send, audited REQUEST_CLASS_NOT_QUALIFIED).
 */
export type BrowserHistoryExplainerDependencies = Readonly<{
  history: RecordedHistoryQueryPort;
  audit: AiInvocationAuditPort;
  manifest?: AiActivationManifest;
  fetcher?: BrowserShellFetcher;
  now?: () => Instant;
  monotonicMs?: () => number;
  requestId?: () => string;
  online?: () => boolean;
  /**
   * Packet 11C Addendum C (C1): which request classes may be sent. Absent (the shipped app) means the shipped gate: the generated
   * definitions and the shipped qualification records, all PENDING, so nothing is sent and no disclosure is shown. Test seam only.
   */
  requestClassGate?: AiRequestClassGate;
  /**
   * Packet 11C Addendum C (C3): a client-visible signal that the server-side remote-AI switch is known to be off (C6 may supply one).
   * True means no AI action or disclosure is offered (a remote attempt could not happen). Absent means "not known off"; a check that
   * throws counts as known off. It never accepts anything: the service and the route decide independently.
   */
  remoteSwitchKnownOff?: () => boolean;
}>;

/** Packet 11C B4b: the runtime's care-preparation ports the care-summary wording reads and replaces through. */
export type BrowserAiAssistanceDependencies = BrowserHistoryExplainerDependencies &
  Readonly<{ carePreparation?: Readonly<{ query: CarePreparationQueryPort; commands: Pick<CarePreparationCommandPort, "replaceWithAiAssistedPreview"> }> }>;

/**
 * Packet 11C B4b: the care-summary preview's AI wording (structurally the preview screen's `CareSummaryAiWordingPort`).
 * - `available(current)`: a remote attempt could actually happen for THIS preview's request: DRAFT_CARE_PREPARATION_SUMMARY is
 *   SYNTHETIC_REMOTE_ENABLED for the release profile, the device is online, the remote switch is not known off, and (Packet 11C
 *   Addendum C, C3, C1 carry) the preview's own projected request class is QUALIFIED. Never true with the shipped manifest or the shipped
 *   records. The screen adds the snapshot conditions (current, unapproved, current-template, deterministic). Reads nothing.
 * - `disclosureRequired(current)` (C3): true whenever `available(current)` is: every explicit request needs its own decision.
 * - `compose(...)`: one explicit request, exactly one audit row (Packet 11C Addendum C, C5: also a not-eligible, stale or unreadable
 *   preview, as a zero-attempt row). `disclosure` (C3) is the patient's answer to the disclosure shown for THIS request: "ACCEPTED" may
 *   send it (bound to its signal; the single repair re-reads it); "DECLINED" composes deterministically, sends nothing and is audited
 *   REMOTE_USE_DECLINED (C5); absent, the request is never sent (REMOTE_USE_NOT_ACCEPTED once it reaches the remote decision).
 * - `disclosureClosed(...)` (C5): the moot disclosure's one DISCLOSURE_CLOSED_MOOT row.
 */
export type BrowserCareSummaryWording = Readonly<{
  available(current: CareSummarySnapshotPayload): boolean;
  disclosureRequired(current: CareSummarySnapshotPayload): boolean;
  compose(input: { snapshotRef: ExpectedHead; locale: AiLocale; disclosure?: AiRemoteUseRequestDecision }, signal?: AbortSignal): Promise<CareSummaryAiOutcome>;
  /**
   * Packet 11C Addendum C (C5): the disclosure shown for an explicit request closed without the patient's decision (locale or preview
   * change, or the screen closed), so that request is moot: one zero-attempt DISCLOSURE_CLOSED_MOOT audit row; nothing is sent.
   */
  disclosureClosed(input: { locale: AiLocale }): Promise<void>;
}>;

export type BrowserAiAssistance = Readonly<{ history: BrowserHistoryExplainer; careSummary: BrowserCareSummaryWording | null }>;

export type BrowserHistoryExplainer = Readonly<{
  /**
   * Explains one comparison (the use case's `explain`): one explicit request, exactly one audit row (C5: a comparison no longer
   * explainable is one NOT_ELIGIBLE row). `disclosure` (Packet 11C Addendum C, C3) is the patient's answer to the disclosure shown for
   * THIS request, bound to its signal: "ACCEPTED" may send it; "DECLINED" (B4a) composes deterministically, sends nothing and is audited
   * REMOTE_USE_DECLINED (C5); absent, it is never sent (REMOTE_USE_NOT_ACCEPTED once it reaches the remote decision).
   */
  explain(input: { factId: string; locale: AiLocale; disclosure?: AiRemoteUseRequestDecision }, signal?: AbortSignal): Promise<PatternExplanation>;
  /**
   * Packet 11C Addendum C (C3): true only when a remote attempt could actually happen for the request the patient is about to make for
   * this comparison in this locale (activated, online, remote switch not known off, and that request's own class QUALIFIED). Reads the
   * comparison's source projection only; writes and sends nothing; never rejects (any failure is false).
   */
  disclosureRequired(input: { factId: string; locale: AiLocale }): Promise<boolean>;
  /**
   * Packet 11C Addendum C (C5): the disclosure shown for an explicit request closed without the patient's decision (view, period or
   * locale change, or the screen closed), so that request is moot: one zero-attempt DISCLOSURE_CLOSED_MOOT audit row; nothing is sent.
   */
  disclosureClosed(input: { locale: AiLocale }): Promise<void>;
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
  // Packet 11C Addendum C (C3): the per-request decisions of this runtime. Only a request's own explicit decision can accept; there is
  // no session and no injectable disclosure. (B4a/B5: a declined signal stays DECLINED; a reused signal never carries an acceptance.)
  const decisions = createAiRemoteUseDecisions();
  const requestClassGate = dependencies.requestClassGate ?? SHIPPED_REQUEST_CLASS_GATE;
  // ONE hybrid service for every flow of this runtime (Packet 11C B4b).
  const service = createAiHybridTaskService({
    releaseProfile: CURRENT_RELEASE_PROFILE,
    audit: dependencies.audit,
    now,
    monotonicMs: dependencies.monotonicMs ?? deviceMonotonicMs,
    manifest,
    provider: createBrowserShellClient({ disclosure: decisions.disclosure, fetcher: dependencies.fetcher }),
    online,
    requestClassGate,
  });
  // Packet 11C B4a: never while offline either (the service would not send, so there is nothing to disclose). Packet 11C Addendum C
  // (C3): nor while the server-side remote switch is known to be off (pluggable; a throwing check counts as off).
  const switchKnownOff = () => {
    try {
      return dependencies.remoteSwitchKnownOff?.() === true;
    } catch {
      return true;
    }
  };
  const remoteEnabled = (taskType: ShellTask) => online() && !switchKnownOff() && resolveAiTaskActivation(taskType, CURRENT_RELEASE_PROFILE, manifest).state === "SYNTHETIC_REMOTE_ENABLED";
  /**
   * Packet 11C Addendum C (C1, C3): whether exactly this request could be sent: the same planner and value-blind projection as the
   * service (reads, writes and sends nothing), then the class gate. A request that is not remote-eligible or of an unqualified class
   * needs no disclosure. Never throws.
   */
  const requestAdmissible = (request: AiTaskRequest) => {
    try {
      const planned = planSlots(request, resolveAiHybridBundle(request.taskType as ShellTask, request.locale));
      if (planned.kind !== "PLANNED" || planned.plan.remote.eligible !== true) return false;
      return requestClassGate.admit(projectShellTaskRequest(planned.plan)).admitted === true;
    } catch {
      return false;
    }
  };
  /** The care preview's own request (the use case's pure builder over the snapshot alone); cached per preview payload object. */
  const careAdmission = new WeakMap<CareSummarySnapshotPayload, boolean>();
  const careRequestAdmissible = (current: CareSummarySnapshotPayload) => {
    const known = careAdmission.get(current);
    if (known !== undefined) return known;
    let admissible = false;
    try {
      const built = buildCareSummaryAiRequest({ current, requestId: requestId(), requestedAt: now() });
      admissible = built.kind === "READY" && requestAdmissible(built.request);
    } catch {
      admissible = false;
    }
    if (typeof current === "object" && current !== null) careAdmission.set(current, admissible);
    return admissible;
  };
  /** The history request the patient is about to make for this comparison and locale (one local read; writes and sends nothing). */
  const historyRequestAdmissible = async (input: { factId: string; locale: AiLocale }): Promise<boolean> => {
    try {
      if (!remoteEnabled("EXPLAIN_PATTERN")) return false;
      const loaded = await dependencies.history.loadExplainablePattern({ factId: input.factId });
      if (loaded.kind !== "EXPLAINABLE") return false;
      const request = buildSourceBackedExplainRequest({ view: loaded.view, locale: input.locale, requestId: requestId(), requestedAt: now() });
      return requestAdmissible(request) && remoteEnabled("EXPLAIN_PATTERN");
    } catch {
      return false;
    }
  };

  // Packet 11C Addendum C (C5): a moot disclosure is its explicit request's one audit row (zero attempts, nothing sent).
  const moot = (taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY") => async (input: { locale: AiLocale }): Promise<void> => {
    await service.recordUnsent({ requestId: requestId(), taskType, locale: input.locale, requestedAt: now(), outcome: "DISCLOSURE_CLOSED_MOOT" });
  };

  const explainer = createPatternExplainer({ history: dependencies.history, execute: service.execute, recordUnsent: service.recordUnsent, now, requestId });
  const history: BrowserHistoryExplainer = Object.freeze({
    explain: (input: { factId: string; locale: AiLocale; disclosure?: AiRemoteUseRequestDecision }, signal?: AbortSignal) =>
      decisions.run(input.disclosure, signal, (token) => explainer.explain({ factId: input.factId, locale: input.locale }, token)),
    disclosureRequired: historyRequestAdmissible,
    disclosureClosed: moot("EXPLAIN_PATTERN"),
  });

  const care = dependencies.carePreparation;
  if (!care) return Object.freeze({ history, careSummary: null });
  const composer = createCareSummaryAiComposer({ query: care.query, commands: care.commands, execute: service.execute, recordUnsent: service.recordUnsent, now, requestId });
  // Packet 11C Addendum C (C3, C1 carry): the action is offered only when this preview's own request could be sent.
  const careAvailable = (current: CareSummarySnapshotPayload) => remoteEnabled("DRAFT_CARE_PREPARATION_SUMMARY") && careRequestAdmissible(current);
  const careSummary: BrowserCareSummaryWording = Object.freeze({
    available: careAvailable,
    // Every explicit request needs its own decision (C3), so the disclosure is required exactly when the request could be sent.
    disclosureRequired: careAvailable,
    compose: (input: { snapshotRef: ExpectedHead; locale: AiLocale; disclosure?: AiRemoteUseRequestDecision }, signal?: AbortSignal) =>
      decisions.run(input.disclosure, signal, (token) => composer.composeCareSummaryWithAi({ snapshotRef: input.snapshotRef, locale: input.locale }, token)),
    disclosureClosed: moot("DRAFT_CARE_PREPARATION_SUMMARY"),
  });
  return Object.freeze({ history, careSummary });
}
