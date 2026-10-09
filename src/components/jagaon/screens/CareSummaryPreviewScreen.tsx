"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { RecordId } from "@/domain/shared";
import type { CareSummaryExportOutcome } from "@/domain/care-preparation/care-summary-export";
import type { CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import type { CarePreparationCommandPort, CarePreparationQueryPort, CareSummaryView, ExpectedHead, PrintObservation } from "@/application/care-preparation/care-preparation-contracts";
import { printableCareSummary } from "@/application/care-preparation/care-summary-artifact";
import { isCurrentCareSummaryTemplate } from "@/application/care-preparation/care-summary-locale-pack";
import { ScreenHeader, Notice } from "../primitives/ScreenHeader";
import { CheckIcon, ChevronLeftIcon, InfoIcon, LockIcon } from "../primitives/Icons";
import { PrintableCareSummary } from "../care-preparation/PrintableCareSummary";
import type { PrintPort } from "../care-preparation/PrintPort";
import { useCareLoad } from "../care-organisation/use-care-load";
import { formatPointTime, localDateOfPoint, formatLocalDate } from "../care-organisation/care-format";
import { AiDisclosureDialog, type AiDisclosurePasscodeEntry } from "../ai/AiDisclosureDialog";

/**
 * Packet 11C Addendum B, Task B4b: the outcome of one care-summary AI wording request (structurally the `composeCareSummaryWithAi`
 * outcome; this screen imports no AI module). Reasons are closed codes and are never shown.
 */
export type CareSummaryAiWordingOutcome =
  | Readonly<{ kind: "REPLACED"; recordId: RecordId }>
  | Readonly<{ kind: "KEPT_DETERMINISTIC"; reason: string }>
  | Readonly<{ kind: "NOT_ELIGIBLE"; reason: string }>
  | Readonly<{ kind: "STALE" }>
  | Readonly<{ kind: "CANCELLED" }>
  | Readonly<{ kind: "UNAVAILABLE" }>;

/**
 * Packet 11C B4b: the care-summary AI wording port (the app passes the care half of its one AI wiring; tests pass fakes).
 * Packet 11C Addendum C, C3 (owner decision: disclosure acceptance is per explicit request):
 * - `available(current)` is true only when a remote attempt could actually happen for THIS preview's request: the care task is
 *   remote-enabled, the device is online and that preview's own request class is qualified (never with the shipped manifest or records);
 *   otherwise the AI action is not shown.
 * - `disclosureRequired(current)` is true whenever such a request could be sent: every explicit request (Retry included) asks again.
 * - `compose`'s `disclosure` is the patient's answer to the dialog shown for THIS request ("ACCEPTED": the primary action only;
 *   "DECLINED": Cancel or Escape, nothing sent); absent when no dialog was shown. It is bound to the request's own signal.
 */
export type CareSummaryAiWordingPort = {
  available(current: CareSummarySnapshotPayload): boolean;
  /** C2 fix round 1 (I-1): may answer asynchronously (the app's wiring awaits the stored "Keep wording on this device" setting). */
  disclosureRequired(current: CareSummarySnapshotPayload): boolean | Promise<boolean>;
  compose(input: { snapshotRef: ExpectedHead; locale: SupportedLocale; disclosure?: "ACCEPTED" | "DECLINED" }, signal?: AbortSignal): Promise<CareSummaryAiWordingOutcome>;
  /**
   * Packet 11C Addendum C (C5): the disclosure shown for an explicit request closed without the patient's decision (locale or preview
   * change, or the screen closed): that moot request's one audit row. Nothing is sent.
   */
  disclosureClosed?(input: { locale: SupportedLocale }): Promise<void>;
  /**
   * Packet 11C Addendum C (C6): the app session's demo passcode entry (in memory only), shown in the disclosure while needed. Absent: no
   * passcode field.
   */
  accessPasscode?: AiDisclosurePasscodeEntry;
};

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  recordId: RecordId;
  query: CarePreparationQueryPort | null;
  commands: CarePreparationCommandPort | null;
  print: PrintPort;
  onBack: () => void;
  /** Packet 11C B4b: the AI wording; absent or null means no AI action. */
  aiWording?: CareSummaryAiWordingPort | null;
  /** Packet 11C B4b: an accepted replacement's new snapshot, which this screen shows next (the app keeps its navigation in step). */
  onReplaced?: (recordId: RecordId) => void;
};

type Notice = "HASH_MISMATCH" | "SOURCE_CHANGED" | "TEMPLATE_SUPERSEDED" | "FAILED" | null;

/**
 * Packet 11C B4b: the AI wording states. DISCLOSURE and LOADING belong to the locale they started in (and DISCLOSURE to the snapshot
 * revision): a locale switch closes the dialog and aborts the request; its late answer is discarded.
 */
type AiPhase =
  | { kind: "IDLE" }
  /** `locale` (Packet 11C Addendum C, C5): the locale of the explicit request the disclosure belongs to (the preview's own). */
  | { kind: "DISCLOSURE"; key: string; locale: SupportedLocale }
  | { kind: "LOADING"; locale: SupportedLocale }
  | { kind: "CANCELLED" }
  | { kind: "NOT_ACCEPTED" }
  | { kind: "FALLBACK"; retry: boolean }
  | { kind: "NOT_ELIGIBLE" }
  | { kind: "STALE" };

const IDLE: AiPhase = { kind: "IDLE" };

/** Closed fallback reasons a new request may overcome (transport, provider and output-validation failures). The rest offer no retry. */
const RETRYABLE_REASONS: ReadonlySet<string> = new Set([
  "TRANSPORT_FAILED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REJECTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_FAILED",
  "MODEL_ABSTAINED",
  "SCHEMA_INVALID",
  "REFERENCE_MISMATCH",
  "FACT_FIDELITY_FAILED",
  "AUTHORITY_BOUNDARY_VIOLATION",
  "CLINICAL_MEANING_VIOLATION",
  "LOCALE_INVALID",
  "OUTPUT_BUDGET_EXCEEDED",
]);

function aiPhaseFor(outcome: Exclude<CareSummaryAiWordingOutcome, { kind: "REPLACED" }>, declined: boolean): AiPhase {
  switch (outcome.kind) {
    case "KEPT_DETERMINISTIC":
      return declined ? { kind: "NOT_ACCEPTED" } : { kind: "FALLBACK", retry: RETRYABLE_REASONS.has(outcome.reason) };
    case "NOT_ELIGIBLE":
      return { kind: "NOT_ELIGIBLE" };
    case "STALE":
      return { kind: "STALE" };
    case "CANCELLED":
      return { kind: "CANCELLED" };
    default:
      return { kind: "FALLBACK", retry: false };
  }
}

/** The factual message for one attempt; none implies sending, delivery or review. */
function outcomeText(messages: AppMessages, outcome: CareSummaryExportOutcome | PrintObservation): string {
  const state = typeof outcome === "string" ? outcome : outcome.state;
  if (state === "EXPORTED" || state === "DIALOG_OPENED") return messages.careSummary.printOpened;
  if (state === "FAILED" || state === "UNAVAILABLE") return messages.careSummary.printUnavailable;
  return messages.careSummary.printUnknown;
}

/**
 * Care-summary preview (plan 9C Task 4). Shows one immutable snapshot,
 * records its preview, binds approval to its exact hash, and runs one
 * print attempt per click: the attempt is recorded before the browser
 * dialog opens and its exact observed outcome is recorded afterwards.
 *
 * Packet 11C B1a: the care-draft notices are part of the snapshot itself (its last, hashed section), so they are shown and printed
 * from the artifact; there is no separate screen-only copy. D3: an unapproved snapshot made with an older template or renderer is
 * shown exactly as stored, is never marked previewed or approved, and the patient is sent back to prepare it again. Human acceptance
 * pending for the new message and its placement.
 *
 * Packet 11C Addendum B, Task B4b (original Task 5, care part): the "Organise with AI" action, placed before the approval controls. It
 * is offered only when the AI wording is `available()` (care task remote-enabled, online; never with the shipped manifest) AND the
 * snapshot is the current, unapproved, current-template, DETERMINISTIC preview. The disclosure comes before any request (Packet 11C
 * Addendum C, C3: for every explicit request, Retry included; an acceptance covers that one request only; Cancel sends nothing). While a request runs the deterministic preview stays readable, approval waits and Cancel aborts. An
 * accepted replacement shows the NEW snapshot with the AI label and check notice (from the snapshot's own composition), recorded as
 * previewed by the ordinary flow; approval remains a separate click and nothing prints on its own. A changed source or head, a fallback,
 * an ineligible preview and a cancel each show one non-technical line; a late answer after a cancel, locale switch or unmount is
 * discarded, except a replacement that already committed (the old preview is then superseded, so the new one is shown). New
 * presentation: human acceptance pending.
 */
export function CareSummaryPreviewScreen({ messages, locale, recordId, query, commands, print, onBack, aiWording = null, onReplaced }: Props) {
  const copy = messages.careSummary;
  const t = messages.ai;
  // Packet 11C B4b: after an accepted replacement this screen shows the new snapshot (the app keeps its navigation in step).
  const [replacement, setReplacement] = useState<RecordId | null>(null);
  const shownRecordId = replacement ?? recordId;
  const loader = useMemo(() => (query ? () => query.loadSummary(shownRecordId) : null), [query, shownRecordId]);
  const { value: view, reload } = useCareLoad<CareSummaryView>(loader, { status: "UNAVAILABLE" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [announcement, setAnnouncement] = useState("");
  const previewRecorded = useRef<string | null>(null);
  const mounted = useRef(true);
  const [aiPhase, setAiPhase] = useState<AiPhase>(IDLE);
  const aiRequest = useRef<{ controller: AbortController } | null>(null);
  const aiResultRef = useRef<HTMLElement | null>(null);
  const focusResultOf = useRef<RecordId | null>(null);
  // Fix round 1: requests whose compose has not settled yet, including one the patient cancelled while its replacement command was
  // already running (B1b: that command may still commit). No new request starts, and Approve waits, until every one has settled.
  const unsettled = useRef(0);
  const [unsettledCount, setUnsettledCount] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A locale switch (and unmount) aborts a pending AI request; its late answer is discarded.
  useEffect(
    () => () => {
      aiRequest.current?.controller.abort();
      aiRequest.current = null;
    },
    [locale],
  );

  const ready = view?.status === "READY" ? view : null;
  const stale = ready !== null && (!ready.sourcesCurrent || ready.snapshotStatus === "INVALIDATED" || ready.snapshotStatus === "SUPERSEDED");
  const printable = useMemo(() => (ready ? printableCareSummary(ready.payload) : null), [ready]);
  // D3: an unapproved preview from an older template or renderer must be prepared again (the service refuses it as well).
  const superseded = ready !== null && !stale && ready.snapshotStatus !== "APPROVED" && (!isCurrentCareSummaryTemplate(ready.payload) || notice === "TEMPLATE_SUPERSEDED");
  const blocked = stale || notice === "HASH_MISMATCH" || superseded;
  // Fix round 1: after an accepted replacement and until the NEW snapshot has loaded, the old (now superseded) preview still on screen
  // is not actionable: no AI action, Approve disabled.
  const replacing = replacement !== null && ready?.recordId !== replacement;
  const aiBusy = unsettledCount > 0 || replacing;

  // Packet 11C B4b: the AI wording is offered only on the current, unapproved, current-template, deterministic preview.
  const aiSnapshot =
    ready !== null &&
    !replacing &&
    !blocked &&
    commands !== null &&
    (ready.snapshotStatus === "PREPARED" || ready.snapshotStatus === "PREVIEWED") &&
    isCurrentCareSummaryTemplate(ready.payload) &&
    ready.payload.composition.method === "DETERMINISTIC";
  // Packet 11C Addendum C (C3, C1 carry): offered only when this preview's own request could be sent (its class qualified).
  const aiOffered = aiWording !== null && aiSnapshot && aiWording.available(ready.payload);
  const aiLoading = aiPhase.kind === "LOADING";
  const disclosureKey = `${ready?.revisionId ?? ""}|${locale}`;
  // C2 fix round 1 (I-1): an asynchronous disclosure check belongs to the preview and locale it was asked for.
  const checkingDisclosure = useRef(false);
  const currentDisclosureKey = useRef(disclosureKey);
  useEffect(() => {
    currentDisclosureKey.current = disclosureKey;
  }, [disclosureKey]);
  // The dialog or the request belongs to the locale (and, for the dialog, the snapshot revision) it was opened in.
  if ((aiPhase.kind === "DISCLOSURE" && aiPhase.key !== disclosureKey) || (aiPhase.kind === "LOADING" && aiPhase.locale !== locale)) setAiPhase(IDLE);

  /**
   * Packet 11C Addendum C, Task C5: the request behind a disclosure that closes without the patient's decision (a locale or preview
   * change, or the screen closing) is moot, and it still writes its one audit row (DISCLOSURE_CLOSED_MOOT; nothing is sent). An answered
   * disclosure is marked decided first. A cleanup immediately followed by the same dialog's effect again (a new port identity, or a
   * development StrictMode remount) is not a close: the report is decided one microtask later, only if that dialog is no longer live.
   */
  const decidedDisclosures = useRef(new WeakSet<AiPhase>());
  const liveDisclosure = useRef<AiPhase | null>(null);
  useEffect(() => {
    if (aiPhase.kind !== "DISCLOSURE" || !aiWording) return;
    const shown = aiPhase;
    const decided = decidedDisclosures.current;
    const live = liveDisclosure;
    const report = aiWording.disclosureClosed?.bind(aiWording);
    live.current = shown;
    return () => {
      if (live.current === shown) live.current = null;
      queueMicrotask(() => {
        if (live.current === shown || decided.has(shown)) return;
        decided.add(shown);
        void Promise.resolve()
          .then(() => report?.({ locale: shown.locale }))
          .catch(() => undefined);
      });
    };
  }, [aiPhase, aiWording]);
  const aiResult = ready !== null && ready.payload.composition.method === "AI_ASSISTED";

  // After an accepted replacement, focus moves to the new preview's AI label once it is shown.
  useEffect(() => {
    if (focusResultOf.current === null || !aiResult || ready?.recordId !== focusResultOf.current) return;
    focusResultOf.current = null;
    aiResultRef.current?.focus();
  }, [aiResult, ready]);

  // Fix round 1: two catalogue sentences are joined with a space in en-SG and directly (full-width punctuation, no space) in zh-SG.
  const sentences = (first: string, second: string) => (locale === "zh-SG" ? `${first}${second}` : `${first} ${second}`);

  function aiLine(phase: AiPhase): string | null {
    switch (phase.kind) {
      case "LOADING":
        return t.careSummary.loading;
      case "CANCELLED":
        return t.cancelled;
      case "NOT_ACCEPTED":
        return t.remoteNotAccepted;
      case "FALLBACK":
        return sentences(t.unavailable, t.careSummary.fallback);
      case "NOT_ELIGIBLE":
        return sentences(t.careSummary.notEligible, t.careSummary.fallback);
      case "STALE":
        return t.careSummary.changed;
      default:
        return null;
    }
  }

  /**
   * One explicit request. `decision` (Packet 11C Addendum C, C3): the patient's answer to the disclosure shown for THIS request, bound to
   * its own signal: "ACCEPTED" lets this one request use AI wording; "DECLINED" means nothing may be sent (audited REMOTE_USE_DECLINED,
   * C5); null when no disclosure was shown. Cancel, a locale switch, unmount or a newer request abort the signal and so end the decision.
   */
  function runAiWording(decision: "ACCEPTED" | "DECLINED" | null) {
    const declined = decision === "DECLINED";
    if (!ready || !aiWording || unsettled.current > 0 || replacing) return;
    aiRequest.current?.controller.abort();
    const request = { controller: new AbortController() };
    aiRequest.current = request;
    unsettled.current += 1;
    setUnsettledCount(unsettled.current);
    setAiPhase({ kind: "LOADING", locale });
    const snapshotRef: ExpectedHead = { recordId: ready.recordId, expectedRevisionId: ready.revisionId, expectedRevisionNumber: ready.revisionNumber };
    void aiWording
      .compose({ snapshotRef, locale: ready.payload.locale, ...(decision ? { disclosure: decision } : {}) }, request.controller.signal)
      .catch((): CareSummaryAiWordingOutcome => ({ kind: "UNAVAILABLE" }))
      .then((outcome) => {
        // Settled (the catch above folds a failure into UNAVAILABLE), in the same update as the resulting state.
        unsettled.current -= 1;
        if (!mounted.current) return;
        setUnsettledCount(unsettled.current);
        if (outcome.kind === "REPLACED") {
          // The replacement committed (possibly after a Cancel during the command): the old preview is now superseded, so the new one
          // is shown, with its AI label; approval stays a separate click.
          // Focus then moves to the new preview's labelled AI region, which announces it. Any other in-flight request is aborted.
          if (aiRequest.current && aiRequest.current !== request) aiRequest.current.controller.abort();
          aiRequest.current = null;
          setAiPhase(IDLE);
          setNotice(null);
          focusResultOf.current = outcome.recordId;
          setReplacement(outcome.recordId);
          onReplaced?.(outcome.recordId);
          return;
        }
        // Cancelled, switched locale or superseded by a newer request: the late answer is discarded.
        if (aiRequest.current !== request || request.controller.signal.aborted) return;
        aiRequest.current = null;
        setAiPhase(aiPhaseFor(outcome, declined));
        // Refresh path: the latest summary is loaded again (a changed source then blocks approval with its own message).
        if (outcome.kind === "STALE") reload();
      });
  }

  // Packet 11C Addendum C (C3): every explicit request (the first action and every Retry) asks again; nothing is remembered.
  // C2 fix round 1 (I-1): the port may answer asynchronously (it awaits the stored "Keep wording on this device" setting). While it is
  // answering, a second click starts nothing; an answer that arrives after the preview, locale or screen changed is dropped (nothing
  // was shown or sent for that click). A failed answer shows no disclosure, so that request can never be sent.
  function startAiWording() {
    if (!ready || !aiWording || !aiOffered || aiBusy || unsettled.current > 0 || checkingDisclosure.current) return;
    const key = disclosureKey;
    const requestLocale = ready.payload.locale;
    const decide = (required: boolean) => {
      if (required) setAiPhase({ kind: "DISCLOSURE", key, locale: requestLocale });
      else runAiWording(null);
    };
    const required = aiWording.disclosureRequired(ready.payload);
    if (typeof required === "boolean") {
      decide(required);
      return;
    }
    checkingDisclosure.current = true;
    void Promise.resolve(required)
      .catch(() => false)
      .then((answer) => {
        checkingDisclosure.current = false;
        if (!mounted.current || currentDisclosureKey.current !== key) return;
        decide(answer);
      });
  }

  // The dialog's primary action: accepts remote use for this one request only (it travels with the request).
  function acceptAiDisclosure() {
    if (aiPhase.kind !== "DISCLOSURE" || !aiWording) return;
    // Answered, so never also moot (C5).
    decidedDisclosures.current.add(aiPhase);
    runAiWording("ACCEPTED");
  }

  function declineAiDisclosure() {
    if (aiPhase.kind !== "DISCLOSURE") return;
    decidedDisclosures.current.add(aiPhase);
    runAiWording("DECLINED");
  }

  function cancelAiWording() {
    aiRequest.current?.controller.abort();
    aiRequest.current = null;
    setAiPhase({ kind: "CANCELLED" });
  }

  // Showing the exact prepared content is the preview; it is recorded once.
  useEffect(() => {
    if (!ready || !commands || stale || ready.snapshotStatus !== "PREPARED" || !isCurrentCareSummaryTemplate(ready.payload) || previewRecorded.current === ready.revisionId) return;
    previewRecorded.current = ready.revisionId;
    void commands
      .markPreviewed({ recordId: ready.recordId, expectedRevisionId: ready.revisionId, expectedRevisionNumber: ready.revisionNumber, contentHash: ready.payload.rendering.contentHash })
      .then((result) => {
        if (!mounted.current) return;
        if (result.kind !== "COMMITTED") {
          const code = result.kind === "REJECTED" ? result.code : null;
          setNotice(code === "SUMMARY_CONTENT_HASH_MISMATCH" ? "HASH_MISMATCH" : code === "SUMMARY_TEMPLATE_SUPERSEDED" ? "TEMPLATE_SUPERSEDED" : "FAILED");
        }
        reload();
      });
  }, [ready, commands, stale, reload]);

  function noticeFor(code: string): Notice {
    if (code === "SUMMARY_CONTENT_HASH_MISMATCH") return "HASH_MISMATCH";
    if (code === "SUMMARY_TEMPLATE_SUPERSEDED") return "TEMPLATE_SUPERSEDED";
    if (code === "SUMMARY_INVALIDATED_FOR_EXPORT" || code === "SUMMARY_NOT_APPROVED") return "SOURCE_CHANGED";
    return "FAILED";
  }

  async function approve() {
    // Fix round 1: never while an AI request is unsettled or the replacement preview is still loading.
    if (!ready || !commands || unsettled.current > 0 || replacing) return;
    setBusy(true);
    setNotice(null);
    const result = await commands.approve({ recordId: ready.recordId, expectedRevisionId: ready.revisionId, expectedRevisionNumber: ready.revisionNumber, contentHash: ready.payload.rendering.contentHash });
    if (!mounted.current) return;
    setBusy(false);
    if (result.kind !== "COMMITTED") setNotice(result.kind === "REJECTED" ? noticeFor(result.code) : "FAILED");
    else setAnnouncement(copy.approvedNote);
    reload();
  }

  async function printAttempt() {
    if (!ready || !commands || !printable) return;
    setBusy(true);
    setNotice(null);
    setAnnouncement("");
    // Preflight and the REQUESTED record come first; no side effect otherwise.
    const requested = await commands.requestPrintExport({ recordId: ready.recordId, expectedRevisionId: ready.revisionId, expectedRevisionNumber: ready.revisionNumber, approvedContentHash: ready.payload.rendering.contentHash });
    if (requested.kind !== "COMMITTED") {
      if (mounted.current) {
        setBusy(false);
        setNotice(requested.kind === "REJECTED" ? noticeFor(requested.code) : "FAILED");
        reload();
      }
      return;
    }
    const observation = await print.print();
    const completed = await commands.completePrintExport({
      recordId: requested.recordId,
      expectedRevisionId: requested.revisionId,
      expectedRevisionNumber: requested.revisionNumber,
      observation,
      artifact: observation === "DIALOG_OPENED" ? { hash: printable.hash, byteLength: printable.byteLength } : null,
    });
    if (!mounted.current) return;
    setBusy(false);
    // If the outcome could not be stored, the attempt is unknown rather than guessed.
    setAnnouncement(outcomeText(messages, completed.kind === "COMMITTED" ? observation : "OUTCOME_UNKNOWN"));
    reload();
  }

  const attemptTime = (outcome: CareSummaryExportOutcome, requestedAt: string) => {
    const at = outcome.state === "EXPORTED" ? outcome.completedAt : outcome.state === "FAILED" ? outcome.failedAt : outcome.state === "OUTCOME_UNKNOWN" ? outcome.lastObservedAt : requestedAt;
    const point = { kind: "EXACT" as const, instantUtc: at as never, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 };
    const date = localDateOfPoint(point);
    return `${date ? formatLocalDate(locale, date) : ""} ${formatPointTime(locale, point) ?? ""}`.trim();
  };

  const backButton = (
    <button type="button" className="btn btn-outline btn-wide" onClick={onBack}>
      <ChevronLeftIcon size={20} />
      {copy.backToPreparation}
    </button>
  );

  return (
    <div className="care-summary-preview">
      <ScreenHeader title={copy.title} />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {view === null ? <p className="care-loading">{copy.loading}</p> : null}
      {view !== null && !ready ? (
        <>
          <div className="banner banner-error" role="alert">
            <p className="banner-title">{copy.unavailableTitle}</p>
          </div>
          {backButton}
        </>
      ) : null}

      {ready && printable ? (
        <>
          {stale ? (
            <div className="banner banner-warning" role="alert">
              <p className="banner-title">{copy.sourceChanged}</p>
            </div>
          ) : null}
          {notice === "HASH_MISMATCH" ? (
            <div className="banner banner-warning" role="alert">
              <p className="banner-title">{copy.hashMismatch}</p>
            </div>
          ) : null}
          {notice === "SOURCE_CHANGED" && !stale ? (
            <div className="banner banner-warning" role="alert">
              <p className="banner-title">{copy.sourceChanged}</p>
            </div>
          ) : null}
          {superseded && notice !== "HASH_MISMATCH" ? (
            <div className="banner banner-warning" role="alert">
              <p className="banner-title">{copy.templateSuperseded}</p>
            </div>
          ) : null}
          {notice === "FAILED" ? (
            <p className="field-error" role="alert">
              {messages.carePreparation.saveFailed}
            </p>
          ) : null}
          {blocked ? backButton : null}

          {aiResult ? (
            <section className="care-summary-ai-result" aria-labelledby="care-summary-ai-result-title" tabIndex={-1} ref={aiResultRef}>
              <h2 className="eyebrow" id="care-summary-ai-result-title">
                {t.careSummary.resultTitle}
              </h2>
              {ready.snapshotStatus !== "APPROVED" ? <p>{t.careSummary.resultBody}</p> : null}
            </section>
          ) : null}

          <PrintableCareSummary lines={printable.lines} locale={ready.payload.locale} />

          {aiWording !== null && (aiOffered || aiPhase.kind !== "IDLE") ? (
            <div className="care-summary-ai">
              {/* The state line is its own polite live region, so it is not repeated in the shared announcement. */}
              <p className="care-summary-ai-line" aria-live="polite">
                {aiLine(aiPhase) ?? ""}
              </p>
              {aiLoading ? (
                <button type="button" className="btn btn-outline btn-wide" onClick={cancelAiWording}>
                  {t.cancel}
                </button>
              ) : aiOffered ? (
                aiPhase.kind === "FALLBACK" && aiPhase.retry ? (
                  <button type="button" className="btn btn-outline btn-wide" disabled={busy || aiBusy || ready.snapshotStatus !== "PREVIEWED"} onClick={startAiWording}>
                    {t.retry}
                  </button>
                ) : aiPhase.kind === "FALLBACK" || aiPhase.kind === "NOT_ELIGIBLE" ? null : (
                  <button type="button" className="btn btn-outline btn-wide" disabled={busy || aiBusy || ready.snapshotStatus !== "PREVIEWED"} onClick={startAiWording}>
                    {t.careSummary.action}
                  </button>
                )
              ) : null}
            </div>
          ) : null}

          {!blocked && commands ? (
            ready.snapshotStatus === "APPROVED" ? (
              <div className="care-summary-actions">
                <Notice icon={<CheckIcon size={20} />}>
                  <p>{copy.approvedNote}</p>
                </Notice>
                <button type="button" className="btn btn-primary btn-wide" disabled={busy || replacing} aria-busy={busy || undefined} onClick={() => void printAttempt()}>
                  {copy.printAction}
                </button>
              </div>
            ) : (
              <div className="care-summary-actions">
                <Notice icon={<InfoIcon size={20} />}>
                  <p>{copy.approvalMeaning}</p>
                </Notice>
                <button type="button" className="btn btn-primary btn-wide" disabled={busy || aiLoading || aiBusy || ready.snapshotStatus !== "PREVIEWED"} aria-busy={busy || undefined} onClick={() => void approve()}>
                  <CheckIcon size={20} />
                  {copy.approveAction}
                </button>
              </div>
            )
          ) : null}

          {ready.exports.length > 0 ? (
            <section className="care-summary-attempts" aria-labelledby="care-summary-attempts-heading">
              <h2 className="eyebrow" id="care-summary-attempts-heading">
                {copy.attemptsHeading}
              </h2>
              <ul aria-labelledby="care-summary-attempts-heading">
                {ready.exports.map((entry) => (
                  <li key={entry.recordId}>
                    <span className="care-summary-attempt-time">{attemptTime(entry.outcome, entry.requestedAt)}</span>
                    <span>{outcomeText(messages, entry.outcome)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <Notice className="notice--compact" icon={<LockIcon size={18} />}>
            <p>{messages.carePreparation.localOnly}</p>
          </Notice>
          {!blocked ? backButton : null}
        </>
      ) : null}
      {aiPhase.kind === "DISCLOSURE" ? <AiDisclosureDialog messages={messages} flow="CARE_SUMMARY" passcode={aiWording?.accessPasscode ?? null} onConfirm={acceptAiDisclosure} onCancel={declineAiDisclosure} /> : null}
    </div>
  );
}
