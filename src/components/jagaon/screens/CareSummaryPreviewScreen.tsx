"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { RecordId } from "@/domain/shared";
import type { CareSummaryExportOutcome } from "@/domain/care-preparation/care-summary-export";
import type { CarePreparationCommandPort, CarePreparationQueryPort, CareSummaryView, PrintObservation } from "@/application/care-preparation/care-preparation-contracts";
import { printableCareSummary } from "@/application/care-preparation/care-summary-artifact";
import { ScreenHeader, Notice } from "../primitives/ScreenHeader";
import { CheckIcon, ChevronLeftIcon, InfoIcon, LockIcon } from "../primitives/Icons";
import { PrintableCareSummary } from "../care-preparation/PrintableCareSummary";
import type { PrintPort } from "../care-preparation/PrintPort";
import { useCareLoad } from "../care-organisation/use-care-load";
import { formatPointTime, localDateOfPoint, formatLocalDate } from "../care-organisation/care-format";

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  recordId: RecordId;
  query: CarePreparationQueryPort | null;
  commands: CarePreparationCommandPort | null;
  print: PrintPort;
  onBack: () => void;
};

type Notice = "HASH_MISMATCH" | "SOURCE_CHANGED" | "FAILED" | null;

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
 */
export function CareSummaryPreviewScreen({ messages, locale, recordId, query, commands, print, onBack }: Props) {
  const copy = messages.careSummary;
  const loader = useMemo(() => (query ? () => query.loadSummary(recordId) : null), [query, recordId]);
  const { value: view, reload } = useCareLoad<CareSummaryView>(loader, { status: "UNAVAILABLE" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [announcement, setAnnouncement] = useState("");
  const previewRecorded = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ready = view?.status === "READY" ? view : null;
  const stale = ready !== null && (!ready.sourcesCurrent || ready.snapshotStatus === "INVALIDATED" || ready.snapshotStatus === "SUPERSEDED");
  const printable = useMemo(() => (ready ? printableCareSummary(ready.payload) : null), [ready]);

  // Showing the exact prepared content is the preview; it is recorded once.
  useEffect(() => {
    if (!ready || !commands || stale || ready.snapshotStatus !== "PREPARED" || previewRecorded.current === ready.revisionId) return;
    previewRecorded.current = ready.revisionId;
    void commands
      .markPreviewed({ recordId: ready.recordId, expectedRevisionId: ready.revisionId, expectedRevisionNumber: ready.revisionNumber, contentHash: ready.payload.rendering.contentHash })
      .then((result) => {
        if (!mounted.current) return;
        if (result.kind !== "COMMITTED") setNotice(result.kind === "REJECTED" && result.code === "SUMMARY_CONTENT_HASH_MISMATCH" ? "HASH_MISMATCH" : "FAILED");
        reload();
      });
  }, [ready, commands, stale, reload]);

  function noticeFor(code: string): Notice {
    if (code === "SUMMARY_CONTENT_HASH_MISMATCH") return "HASH_MISMATCH";
    if (code === "SUMMARY_INVALIDATED_FOR_EXPORT" || code === "SUMMARY_NOT_APPROVED") return "SOURCE_CHANGED";
    return "FAILED";
  }

  async function approve() {
    if (!ready || !commands) return;
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
          {notice === "FAILED" ? (
            <p className="field-error" role="alert">
              {messages.carePreparation.saveFailed}
            </p>
          ) : null}
          {stale || notice === "HASH_MISMATCH" ? backButton : null}

          <PrintableCareSummary lines={printable.lines} locale={ready.payload.locale} />

          {!stale && notice !== "HASH_MISMATCH" && commands ? (
            ready.snapshotStatus === "APPROVED" ? (
              <div className="care-summary-actions">
                <Notice icon={<CheckIcon size={20} />}>
                  <p>{copy.approvedNote}</p>
                </Notice>
                <button type="button" className="btn btn-primary btn-wide" disabled={busy} aria-busy={busy || undefined} onClick={() => void printAttempt()}>
                  {copy.printAction}
                </button>
              </div>
            ) : (
              <div className="care-summary-actions">
                <Notice icon={<InfoIcon size={20} />}>
                  <p>{copy.approvalMeaning}</p>
                </Notice>
                <button type="button" className="btn btn-primary btn-wide" disabled={busy || ready.snapshotStatus !== "PREVIEWED"} aria-busy={busy || undefined} onClick={() => void approve()}>
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
          {!stale && notice !== "HASH_MISMATCH" ? backButton : null}
        </>
      ) : null}
    </div>
  );
}
