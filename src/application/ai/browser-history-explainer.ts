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
import { createAiRemoteUseDecisions, createBrowserShellClient, fetchAiPasscodeRequirement, type AiRemoteUseRequestDecision, type BrowserShellFetcher } from "./browser-shell-client";
import type { AiShellRouteRefusalReason } from "./ai-shell-route-contract";
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
 *   `anyAdmissible`). Care: that preview's own request. Packet 11C English activation (owner decisions Q and A): with the shipped
 *   manifest and records it is offered only for an en-SG request of a QUALIFIED class; never in zh-SG (PENDING) and never for a request
 *   outside the evaluated classes.
 *
 * Only the history, care-preparation and audit ports are passed by the shipped app. The other dependencies are test seams (an injected
 * test manifest, a fake fetcher, a fixed clock, a test-only request-class gate, a remote switch signal).
 *
 * Packet 11C Addendum B, Task B4b: `createBrowserAiAssistance` is the app's ONE AI wiring per opened runtime. The SAME hybrid service
 * (so the same browser shell client, per-request decisions and audit port) serves the history explanation and the care-summary AI
 * wording (`composeCareSummaryWithAi` over the runtime's care-preparation ports). `createBrowserHistoryExplainer` is its history half.
 * The care wording is `available()` (and asks the disclosure) only for a preview whose own request may be sent; otherwise the preview
 * screen does not show its action and nothing is sent. A DETERMINISTIC hybrid result never creates a replacement snapshot (the use case replaces only from a validated AI
 * composition, and the runtime's care service re-validates it with `projectValidatedAiCareSummary`).
 *
 * Packet 11C Addendum C, Task C1: the one hybrid service gets the request-class gate (shipped: since the Packet 11C English activation the
 * six en-SG classes are QUALIFIED; any other request composes deterministically before any disclosure or send, audited
 * REQUEST_CLASS_NOT_QUALIFIED).
 *
 * Packet 11C Addendum C, Task C6 (owner approval of Addendum C; C6 amendment):
 * - Demo passcode: one in-memory entry per runtime (`accessPasscode`, the same object on both flows). The disclosure dialog asks for it
 *   while `needed()` (it is shown only when a remote attempt could happen, so never with the shipped manifest); the browser shell client
 *   reads it on each remote POST and sends it only as a request header. It is never persisted (no storage, backup, settings, audit row
 *   or log). A route ACCESS_DENIED refusal forgets it, so the next disclosure asks again.
 * - Server switch signal (the smallest truthful design; no pre-flight request, no configuration value reaches the browser): the route's
 *   own REMOTE_AI_DISABLED refusal sets a boolean for this runtime, so no further disclosure is offered and later requests are audited
 *   REMOTE_AI_DISABLED without a send; `remoteSwitchKnownOff` stays an additional pluggable check. The route remains the enforcement
 *   point for the switch, origin, access and spend; every route refusal is audited with its own code and no attempt.
 *
 * Owner decision 2026-10-12 (optional passcodes): the passcode entry is `needed()` only while a passcode is held by nobody AND the
 * deployment is not known to require none. The runtime learns that from the passcode probe (`passcodeProbe`; production: the route's
 * `GET /api/ai/shell`, `fetchAiPasscodeRequirement`), asked only when a disclosure is about to be required for an explicit request
 * (never with the shipped manifest, in private mode, offline, with the switch known off or for an unqualified class) and once per
 * runtime: "not required" is kept; an unknown answer (a failure) keeps the field and is asked again next time. A route ACCESS_DENIED
 * makes the passcode required again (the deployment changed). The route still decides every request.
 * Owner decision 2026-10-12 (AI credit dialog): an accepted request the route refused because the AI credit is used up (the daily
 * spend limit, SPEND_CEILING_REACHED, or the DeepSeek balance, OPERATIONAL_SPEND_LOCKED; told by the client's `onCreditLimit`) comes
 * back with the standard wording marked `remoteUse: "CREDIT_LIMIT_REACHED"` (history: instead of U12's marker; care: on its
 * KEPT_DETERMINISTIC outcome), so the screens show the credit dialog. Nothing else changes: the audit row keeps its own code.
 *
 * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting (`privateMode`, read per
 * request) is passed to the one hybrid service and is the first condition of "a remote attempt could happen": while it is on, no
 * disclosure, passcode field or care AI action is offered, and each explicit request is composed in the browser and audited
 * PRIVACY_REJECTED (mode PRIVATE) with nothing sent. The C3 decisions and the C6 route checks are unchanged.
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
   * definitions and the shipped qualification records (six en-SG QUALIFIED, six zh-SG PENDING), so only an en-SG request of a qualified
   * class may ask the disclosure and be sent. Test seam only.
   */
  requestClassGate?: AiRequestClassGate;
  /**
   * Packet 11C Addendum C (C3): a client-visible signal that the server-side remote-AI switch is known to be off (C6 may supply one).
   * True means no AI action or disclosure is offered (a remote attempt could not happen). Absent means "not known off"; a check that
   * throws counts as known off. It never accepts anything: the service and the route decide independently.
   */
  remoteSwitchKnownOff?: () => boolean;
  /**
   * Owner decision 2026-10-12 (optional passcodes): the passcode entry is `needed()` only while a passcode is held by nobody AND the
   * deployment is not known to require none. The runtime learns that from the passcode probe (`passcodeProbe`; production: the route's
   * `GET /api/ai/shell`, `fetchAiPasscodeRequirement`), asked only when a disclosure is about to be required for an explicit request
   * (never with the shipped manifest, in private mode, offline, with the switch known off or for an unqualified class) and once per
   * runtime: "not required" is kept; an unknown answer (a failure) keeps the field and is asked again next time. A route ACCESS_DENIED
   * makes the passcode required again (the deployment changed). The route still decides every request.
   * Owner decision 2026-10-12 (AI credit dialog): an accepted request the route refused because the AI credit is used up (the daily
   * spend limit, SPEND_CEILING_REACHED, or the DeepSeek balance, OPERATIONAL_SPEND_LOCKED; told by the client's `onCreditLimit`) comes
   * back with the standard wording marked `remoteUse: "CREDIT_LIMIT_REACHED"` (history: instead of U12's marker; care: on its
   * KEPT_DETERMINISTIC outcome), so the screens show the credit dialog. Nothing else changes: the audit row keeps its own code.
   *
   * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting. The shipped app passes a
   * function over the stored setting; it is read per request (a change applies from the next request, no rebuild). True: no AI action or
   * disclosure is offered (so no passcode field), and every explicit request of either flow composes deterministically in the browser,
   * audited PRIVACY_REJECTED (mode PRIVATE, zero attempts, usage basis NONE) under every manifest; nothing is sent. Absent: off. A check
   * that throws counts as on.
   * C2 fix round 1 (I-1): it may answer asynchronously (the app: this tab's choice, else the STORED value, so a change made in another
   * tab counts at once); it is awaited by both disclosure checks and the service, and a rejection counts as on.
   */
  privateMode?: () => boolean | Promise<boolean>;
  /**
   * C2 fix round 1 (I-1): this tab's in-memory value, for render-time offers that must answer synchronously (the care action's
   * `available`). Never decisive for a send: the disclosure checks and the service await `privateMode`. Absent: a synchronous
   * `privateMode` answer is used. A hint that throws counts as on.
   */
  privateModeHint?: () => boolean;
  /**
   * Owner decision 2026-10-12 (optional passcodes): whether the deployment requires the demo passcode (true / false), or null when
   * unknown. Absent: the production probe (`GET /api/ai/shell` through the browser's fetch) when no test `fetcher` is injected; with
   * an injected `fetcher` and no probe, nothing is probed and the passcode stays required (today's behaviour; the fetcher sees POSTs
   * only). Asked only when a disclosure is about to be required.
   */
  passcodeProbe?: () => Promise<boolean | null>;
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
/**
 * Owner decision 2026-10-12 (AI credit dialog): the care outcome, whose KEPT_DETERMINISTIC carries `remoteUse: "CREDIT_LIMIT_REACHED"`
 * when the route said the AI credit is used up for that request.
 */
export type BrowserCareSummaryOutcome = CareSummaryAiOutcome | Readonly<{ kind: "KEPT_DETERMINISTIC"; reason: Extract<CareSummaryAiOutcome, { kind: "KEPT_DETERMINISTIC" }>["reason"]; remoteUse: "CREDIT_LIMIT_REACHED" }>;

export type BrowserCareSummaryWording = Readonly<{
  available(current: CareSummarySnapshotPayload): boolean;
  /** C2 fix round 1 (I-1): asynchronous, so it can await the stored "Keep wording on this device" setting; never rejects. */
  disclosureRequired(current: CareSummarySnapshotPayload): Promise<boolean>;
  compose(input: { snapshotRef: ExpectedHead; locale: AiLocale; disclosure?: AiRemoteUseRequestDecision }, signal?: AbortSignal): Promise<BrowserCareSummaryOutcome>;
  /**
   * Packet 11C Addendum C (C5): the disclosure shown for an explicit request closed without the patient's decision (locale or preview
   * change, or the screen closed), so that request is moot: one zero-attempt DISCLOSURE_CLOSED_MOOT audit row; nothing is sent.
   */
  disclosureClosed(input: { locale: AiLocale }): Promise<void>;
  /** Packet 11C Addendum C (C6): the runtime's demo passcode entry (the same object for both flows). */
  accessPasscode: AiAccessPasscodeEntry;
}>;

export type BrowserAiAssistance = Readonly<{ history: BrowserHistoryExplainer; careSummary: BrowserCareSummaryWording | null }>;

/**
 * Packet 11C Addendum C (C6): the demo passcode entry the disclosure dialog uses (structurally the dialog's own prop type). `needed()`:
 * no passcode is held in this runtime (none entered yet, or the route denied the last one). `provide(passcode)`: holds a sendable
 * passcode in memory for this runtime; false (and nothing held) for anything that cannot travel as a header. It accepts no remote use.
 */
export type AiAccessPasscodeEntry = Readonly<{ needed(): boolean; provide(passcode: string): boolean }>;

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
  /** Packet 11C Addendum C (C6): the runtime's demo passcode entry (the same object for both flows). */
  accessPasscode: AiAccessPasscodeEntry;
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
  // Packet 11C Addendum C (C6): the demo passcode of this runtime (in memory only) and the server switch learned from the route.
  // Owner decision 2026-10-12 (optional passcodes): the production probe unless a test seam stands in (see `passcodeProbe`).
  const passcodeProbe = dependencies.passcodeProbe ?? (dependencies.fetcher ? null : () => fetchAiPasscodeRequirement());
  const passcode = createPasscodeEntry(passcodeProbe);
  let switchOffAtRoute = false;
  const onRefusal = (reason: AiShellRouteRefusalReason) => {
    if (reason === "REMOTE_AI_DISABLED") switchOffAtRoute = true;
    if (reason === "ACCESS_DENIED") passcode.denied();
  };
  // Owner decision 2026-10-12 (AI credit dialog): the explicit requests (by decision token) the route refused for a used-up AI credit.
  const creditLimited = new WeakSet<AbortSignal>();
  const noteCreditLimit = (token: AbortSignal) => void creditLimited.add(token);
  // Packet 11C B4a: never while offline either (the service would not send, so there is nothing to disclose). Packet 11C Addendum C
  // (C3): nor while the server-side remote switch is known to be off (pluggable; a throwing check counts as off). C6: known off also
  // once the route itself refused with REMOTE_AI_DISABLED in this runtime (boolean only; the route stays the enforcement point).
  const switchKnownOff = () => {
    if (switchOffAtRoute) return true;
    try {
      return dependencies.remoteSwitchKnownOff?.() === true;
    } catch {
      return true;
    }
  };
  // Packet 11C Addendum C (C2; fix round 1 I-1): the patient's "Keep wording on this device" setting, awaited per request (the app
  // passes this tab's choice, else the stored value another tab may have changed); a throwing or rejecting check counts as on.
  const keepWordingOnDevice = async () => {
    try {
      return (await dependencies.privateMode?.()) === true;
    } catch {
      return true;
    }
  };
  // Render-time offers (the care action's `available`, which must answer synchronously) use this tab's in-memory value (`privateModeHint`,
  // kept in step with other tabs by the change notice); without a hint, a synchronous `privateMode` answer. Every decision that can lead
  // to a send (both disclosure checks and the service) awaits `keepWordingOnDevice` instead.
  const keepWordingHint = () => {
    try {
      if (dependencies.privateModeHint) return dependencies.privateModeHint() === true;
      const value = dependencies.privateMode?.();
      if (value instanceof Promise) {
        void value.catch(() => undefined);
        return false;
      }
      return value === true;
    } catch {
      return true;
    }
  };
  // Owner UI decision U12 (2026-10-09): the explicit requests (by decision token) for which the browser actually POSTed to the route.
  const postedRequests = new WeakSet<AbortSignal>();
  const notePost = (token: AbortSignal) => void postedRequests.add(token);
  // ONE hybrid service for every flow of this runtime (Packet 11C B4b).
  const service = createAiHybridTaskService({
    releaseProfile: CURRENT_RELEASE_PROFILE,
    audit: dependencies.audit,
    now,
    monotonicMs: dependencies.monotonicMs ?? deviceMonotonicMs,
    manifest,
    provider: createBrowserShellClient({ disclosure: decisions.disclosure, fetcher: dependencies.fetcher, accessPasscode: passcode.read, onRefusal, onPost: notePost, onCreditLimit: noteCreditLimit }),
    privateMode: keepWordingOnDevice,
    online,
    requestClassGate,
    remoteSwitchKnownOff: switchKnownOff,
  });
  const remoteEnabled = (taskType: ShellTask) =>
    !keepWordingHint() && online() && !switchKnownOff() && resolveAiTaskActivation(taskType, CURRENT_RELEASE_PROFILE, manifest).state === "SYNTHETIC_REMOTE_ENABLED";
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
      // C2 fix round 1 (I-1): the awaited setting (another tab may have turned it on), not only this tab's in-memory value.
      if (!remoteEnabled("EXPLAIN_PATTERN") || (await keepWordingOnDevice())) return false;
      const loaded = await dependencies.history.loadExplainablePattern({ factId: input.factId });
      if (loaded.kind !== "EXPLAINABLE") return false;
      const request = buildSourceBackedExplainRequest({ view: loaded.view, locale: input.locale, requestId: requestId(), requestedAt: now() });
      const required = requestAdmissible(request) && remoteEnabled("EXPLAIN_PATTERN") && !(await keepWordingOnDevice());
      // Owner decision 2026-10-12 (optional passcodes): learn whether the dialog needs the passcode field (never rejects).
      if (required) await passcode.learn();
      return required;
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
      decisions.run(input.disclosure, signal, async (token) => {
        const result = await explainer.explain({ factId: input.factId, locale: input.locale }, token);
        // U12: the standard wording after a remote request that was actually POSTed (and then failed or was refused) is marked, so the
        // panel shows the owner's fallback line. Never for a request that was not POSTed (deterministic use, private mode, not
        // qualified, switch known off, offline, declined or no decision) and never for an AI result.
        const attempted = token !== undefined && postedRequests.has(token);
        if (!attempted || result.kind !== "EXPLAINED" || result.source !== "DETERMINISTIC" || result.remoteUse !== undefined) return result;
        // Owner decision 2026-10-12 (AI credit dialog): a used-up AI credit is its own marker (the panel shows the credit dialog).
        return { ...result, remoteUse: creditLimited.has(token) ? ("CREDIT_LIMIT_REACHED" as const) : ("UNAVAILABLE_AFTER_REQUEST" as const) };
      }),
    disclosureRequired: historyRequestAdmissible,
    disclosureClosed: moot("EXPLAIN_PATTERN"),
    accessPasscode: passcode.entry,
  });

  const care = dependencies.carePreparation;
  if (!care) return Object.freeze({ history, careSummary: null });
  const composer = createCareSummaryAiComposer({ query: care.query, commands: care.commands, execute: service.execute, recordUnsent: service.recordUnsent, now, requestId });
  // Packet 11C Addendum C (C3, C1 carry): the action is offered only when this preview's own request could be sent.
  const careAvailable = (current: CareSummarySnapshotPayload) => remoteEnabled("DRAFT_CARE_PREPARATION_SUMMARY") && careRequestAdmissible(current);
  const careSummary: BrowserCareSummaryWording = Object.freeze({
    available: careAvailable,
    // Every explicit request needs its own decision (C3), so the disclosure is required exactly when the request could be sent.
    // C2 fix round 1 (I-1): with the awaited setting (another tab may have turned it on); never rejects.
    // Owner decision 2026-10-12 (optional passcodes): when it is required, the dialog's passcode need is learned first (never rejects).
    disclosureRequired: async (current: CareSummarySnapshotPayload) => {
      const required = careAvailable(current) && !(await keepWordingOnDevice());
      if (required) await passcode.learn();
      return required;
    },
    compose: (input: { snapshotRef: ExpectedHead; locale: AiLocale; disclosure?: AiRemoteUseRequestDecision }, signal?: AbortSignal) =>
      decisions.run(input.disclosure, signal, async (token): Promise<BrowserCareSummaryOutcome> => {
        const outcome = await composer.composeCareSummaryWithAi({ snapshotRef: input.snapshotRef, locale: input.locale }, token);
        // Owner decision 2026-10-12 (AI credit dialog): the standard wording kept because the AI credit is used up.
        return outcome.kind === "KEPT_DETERMINISTIC" && token !== undefined && creditLimited.has(token) ? { ...outcome, remoteUse: "CREDIT_LIMIT_REACHED" as const } : outcome;
      }),
    disclosureClosed: moot("DRAFT_CARE_PREPARATION_SUMMARY"),
    accessPasscode: passcode.entry,
  });
  return Object.freeze({ history, careSummary });
}

/** A passcode the route could accept as a header value: 1 to 128 visible ASCII characters (the route itself requires 8 to 128). */
const SENDABLE_PASSCODE = /^[\x21-\x7e]{1,128}$/;

/**
 * Packet 11C Addendum C (C6): the demo passcode of one runtime. Held in this closure only: never written to storage, a backup, settings,
 * an audit row or a log, and gone when the runtime (the app session) ends. The disclosure dialog asks for it while `needed()`.
 * Owner decision 2026-10-12 (optional passcodes): `learn()` asks the probe (at most one at a time; never rejects) until it answers;
 * "not required" makes `needed()` false while nothing is held. `denied()` (a route ACCESS_DENIED) forgets the value and marks the
 * passcode required again. No answer, a failure or no probe: required (the field is shown, as before).
 */
function createPasscodeEntry(probe: (() => Promise<boolean | null>) | null) {
  let value: string | null = null;
  let requirement: "UNKNOWN" | "REQUIRED" | "NOT_REQUIRED" = "UNKNOWN";
  let asking: Promise<void> | null = null;
  const learn = (): Promise<void> => {
    if (requirement !== "UNKNOWN" || probe === null) return Promise.resolve();
    asking ??= Promise.resolve()
      .then(probe)
      .then(
        (answer) => {
          if (requirement === "UNKNOWN" && typeof answer === "boolean") requirement = answer ? "REQUIRED" : "NOT_REQUIRED";
        },
        () => undefined,
      )
      .finally(() => {
        asking = null;
      });
    return asking;
  };
  const entry: AiAccessPasscodeEntry = Object.freeze({
    needed: () => value === null && requirement !== "NOT_REQUIRED",
    provide: (passcode: string) => {
      if (typeof passcode !== "string" || !SENDABLE_PASSCODE.test(passcode)) return false;
      value = passcode;
      return true;
    },
  });
  const denied = () => {
    value = null;
    requirement = "REQUIRED";
  };
  return Object.freeze({ entry, read: () => value, denied, learn });
}
