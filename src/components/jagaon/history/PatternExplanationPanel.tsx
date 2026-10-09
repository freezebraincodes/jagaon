"use client";

import { useEffect, useMemo, useRef } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { ExplainablePatternView, PeriodBoundary, SupportingReading } from "@/application/history/recorded-history-contracts";
import { careSummaryLocalePack } from "@/application/care-preparation/care-summary-locale-pack";
import { InfoIcon } from "../primitives/Icons";

/**
 * Packet 11C Task 7: the explanation of one explainable comparison, shown under the unchanged 7A card text.
 *
 * The result shape is declared here, structurally, so that this browser module never imports the AI application modules (the
 * Packet 11A/11B client-graph pins keep them out of the page). `createPatternExplainer` (`src/application/ai/explain-pattern.ts`)
 * satisfies `PatternExplainerPort`; the tests pin that assignability.
 *
 * Every displayed value is the view's or the composition's own: the explanation fields, the summary-role line and the limitation
 * come from the use case; the supporting readings are listed exactly as `view.periods[i].readings` groups them (never re-sorted by
 * time strings), each with its own recorded local date and time; the period endpoints and the shared cutoff are derived from the
 * view's instants. One date formatter is used throughout: the care-summary locale pack's `localDateText`, with 24-hour times.
 *
 * Packet 11C B4a (owner decisions 2 and 3, D7, B3 carries; every new string and its presentation human acceptance pending): the endpoints
 * and the cutoff are named in Singapore time; every reading recorded at an offset other than +08:00 also shows its actual offset label
 * and its exact Singapore-time equivalent (from its source instant); the list is headed "Readings included in this comparison (n)";
 * an explanation whose remote use was not accepted shows a short non-technical line beside the standard wording.
 *
 * Packet 11C Addendum C, Task C4: an AI-sourced explanation shows the approved rows ai.demoTag (labelling the region that wraps the
 * generated text) and ai.resultCheck; a deterministic one shows neither. Human acceptance pending for placement and appearance.
 */
export type PatternExplanationResult =
  | {
      kind: "EXPLAINED";
      source: "AI" | "DETERMINISTIC";
      view: ExplainablePatternView;
      composition: { taskType: string; output: { taskType: string; payload: unknown } };
      limitations: readonly { limitationRef: string; code: string; text: string }[];
      summaryRoleNotice: string;
      /**
       * Packet 11C B3: "NOT_ACCEPTED" only when the remote-use disclosure was not accepted (the deterministic explanation; nothing sent).
       * Owner UI decision U12: "UNAVAILABLE_AFTER_REQUEST" only when a remote request was actually POSTed and then failed or was refused
       * (the deterministic explanation with the owner's fallback line).
       */
      remoteUse?: "NOT_ACCEPTED" | "UNAVAILABLE_AFTER_REQUEST";
    }
  | { kind: "UNAVAILABLE"; reason: string };

export type PatternExplainerPort = {
  /**
   * `disclosure` (Packet 11C Addendum C, C3) is the patient's answer to the AI disclosure shown for THIS request, bound to the request's
   * own signal: "ACCEPTED" (the dialog's primary action only) lets that one request use AI wording; "DECLINED" (B4a: Cancel or Escape)
   * explains it with the standard wording, sends nothing and is audited as declined. Absent: no decision, so nothing is sent.
   */
  explain(input: { factId: string; locale: SupportedLocale; disclosure?: "ACCEPTED" | "DECLINED" }, signal?: AbortSignal): Promise<PatternExplanationResult>;
  /**
   * Packet 11C Addendum C (C3): true only when the request the patient is about to make for this comparison and locale could actually
   * use the remote route (activated, online, its own class qualified); the screen then shows the disclosure BEFORE calling `explain`.
   * Every request asks again (acceptance is per request). Absent or false: no disclosure (never while NOT_ACTIVATED).
   */
  disclosureRequired?(input: { factId: string; locale: SupportedLocale }): Promise<boolean>;
  /**
   * Packet 11C Addendum C (C5): the disclosure the screen showed for an explicit request closed without the patient's decision (view,
   * period or locale change, or the screen closed): that moot request's one audit row. Nothing is sent.
   */
  disclosureClosed?(input: { locale: SupportedLocale }): Promise<void>;
  /**
   * Packet 11C Addendum C (C6): the app session's demo passcode entry (in memory only), shown in the disclosure while needed. Absent: no
   * passcode field. Declared structurally (this panel imports no `ai` module; it is the disclosure dialog's entry type).
   */
  accessPasscode?: Readonly<{ needed(): boolean; provide(passcode: string): boolean }>;
};

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  /** `null` while the explanation is being prepared. */
  explanation: PatternExplanationResult | null;
  panelId: string;
};

const UNIT_TEXT: Readonly<Record<SupportingReading["enteredUnit"], string>> = { MMOL_L: "mmol/L", MG_DL: "mg/dL" };

/** "date, time" (en-SG) / "date time" (zh-SG), matching the care-summary point text punctuation. */
function dateTimeText(localDateText: (date: string) => string, locale: SupportedLocale, date: string, time: string): string {
  return `${localDateText(date)}${locale === "zh-SG" ? " " : ", "}${time}`;
}

/** Singapore's fixed UTC offset (+08:00, no daylight saving): the evaluator's home offset and the cutoff's time zone. */
const SINGAPORE_OFFSET_MINUTES = 480;

/**
 * Packet 11C B4a (owner decision 2, D7): an instant as a Singapore-time point ("date, HH:MM Singapore time" / "date 新加坡时间HH:MM"),
 * computed from the instant alone. The time is HH:MM when the instant has no seconds or milliseconds, otherwise HH:MM:SS (`withSeconds`),
 * floored: it never rounds up across the cutoff, so "before" / "at or after" stay exact.
 */
function singaporeTimeText(t: AppMessages["history"]["explanation"], localDateText: (date: string) => string, instant: string, withSeconds: boolean): string {
  const instantMs = Date.parse(instant);
  const local = new Date(instantMs + SINGAPORE_OFFSET_MINUTES * 60_000).toISOString();
  const time = withSeconds && instantMs % 60_000 !== 0 ? local.slice(11, 19) : local.slice(11, 16);
  return t.singaporeTime(localDateText(local.slice(0, 10)), time);
}

/** A period endpoint (Task 6R), derived from its instant and named in Singapore time (B4a). */
function boundaryText(t: AppMessages["history"]["explanation"], localDateText: (date: string) => string, bound: PeriodBoundary): string {
  return singaporeTimeText(t, localDateText, bound.instant, true);
}

/** "UTC+05:30" / "UTC-09:30" / "UTC+00:00": the reading's actual recorded offset, never inferred. */
function offsetLabel(utcOffsetMinutes: number): string {
  const sign = utcOffsetMinutes < 0 ? "-" : "+";
  const minutes = Math.abs(utcOffsetMinutes);
  return `UTC${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * A supporting reading's "when": its recorded local date and time. Packet 11C B4a (D7): EVERY reading recorded at an offset other than
 * +08:00 also shows its actual offset label and its exact Singapore-time equivalent, computed from its source instant. Its period is
 * never decided here: the caller lists it where the view groups it.
 */
function readingWhen(t: AppMessages["history"]["explanation"], localDateText: (date: string) => string, locale: SupportedLocale, reading: SupportingReading): string {
  const recorded = dateTimeText(localDateText, locale, reading.localDate, reading.localTime);
  if (reading.utcOffsetMinutes === SINGAPORE_OFFSET_MINUTES) return recorded;
  return t.offsetReading(recorded, offsetLabel(reading.utcOffsetMinutes), singaporeTimeText(t, localDateText, reading.instantUtc, false));
}

/**
 * The supporting-readings copy the panel shows, as plain strings: the heading, per period its heading, its endpoint range (with the
 * shared cutoff) and every reading's "when" and value text, the boundary note and the reconciliation line. Pure; exported so the
 * offline review page (`packet-11-source-backed-replay.test.ts`) renders exactly these strings with this one formatter.
 */
export type SupportingReadingsCopy = Readonly<{
  heading: string;
  periods: readonly Readonly<{
    role: ExplainablePatternView["periods"][number]["role"];
    heading: string;
    /** "start up to, but not including, cutoff" / "cutoff up to, but not including, end"; null without a shared cutoff. */
    range: string | null;
    readings: readonly Readonly<{ key: string; when: string; value: string }>[];
  }>[];
  boundaryNote: string | null;
  reconciliation: string;
}>;

export function supportingReadingsCopy(messages: AppMessages, locale: SupportedLocale, view: ExplainablePatternView): SupportingReadingsCopy {
  const t = messages.history.explanation;
  const { localDateText } = careSummaryLocalePack(locale);
  const [earlier, recent] = view.periods;
  const cutoff = view.sharedBoundary ? boundaryText(t, localDateText, view.sharedBoundary) : null;
  return {
    heading: t.supportingHeading(view.totalCount),
    periods: view.periods.map((period) => ({
      role: period.role,
      heading: t.periodHeading(period.role, period.count),
      range:
        cutoff === null
          ? null
          : period.role === "EARLIER"
            ? t.earlierRange(boundaryText(t, localDateText, period.bounds.start), cutoff)
            : t.recentRange(cutoff, boundaryText(t, localDateText, period.bounds.end)),
      readings: period.readings.map((reading) => ({
        key: `${reading.ref.recordId}:${reading.ref.revisionId}`,
        when: readingWhen(t, localDateText, locale, reading),
        value: `${reading.enteredValue} ${UNIT_TEXT[reading.enteredUnit]}`,
      })),
    })),
    boundaryNote: cutoff === null ? null : t.boundaryNote(cutoff),
    reconciliation: t.reconciliation(earlier.count, recent.count, view.totalCount),
  };
}

type ExplainText = { headline: string; observation: string; evidence: string };

/** The three composed EXPLAIN fields, or null when the composition is not a complete EXPLAIN output (fails closed). */
function explainText(composition: Extract<PatternExplanationResult, { kind: "EXPLAINED" }>["composition"]): ExplainText | null {
  if (composition.taskType !== "EXPLAIN_PATTERN" || composition.output.taskType !== "EXPLAIN_PATTERN") return null;
  const payload = composition.output.payload as Partial<Record<keyof ExplainText, { text?: unknown }>> | null;
  const headline = payload?.headline?.text;
  const observation = payload?.observation?.text;
  const evidence = payload?.evidence?.text;
  if (typeof headline !== "string" || typeof observation !== "string" || typeof evidence !== "string") return null;
  return { headline, observation, evidence };
}

export function PatternExplanationPanel({ messages, locale, explanation, panelId }: Props) {
  const t = messages.history.explanation;
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Keyboard: the heading takes focus once, when the panel opens.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const explained = explanation?.kind === "EXPLAINED" ? explanation : null;
  const text = explained ? explainText(explained.composition) : null;
  const shown = explained && text ? { ...explained, text } : null;
  // The live region exists from the start and receives one message per outcome: the headline, or why there is none.
  const statusText =
    explanation === null ? "" : shown ? shown.text.headline : explanation.kind === "UNAVAILABLE" && explanation.reason === "STALE_RESULT" ? t.stale : t.unavailable;

  const headingId = `${panelId}-heading`;
  const aiTagId = `${panelId}-ai-tag`;
  // Packet 11C Addendum C, C4: AI-sourced output only. Deterministic output never shows an AI tag (owner: "no misleading labels on
  // deterministic output").
  const aiSourced = shown?.source === "AI";
  return (
    <section id={panelId} className="history-explanation" aria-labelledby={headingId} aria-busy={explanation === null}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="history-explanation-title">
        {t.title}
      </h3>
      {explanation === null ? (
        <p className="history-explanation-loading">{messages.shared.loading}</p>
      ) : null}
      {/*
       * Packet 11C Addendum C, C4 (B4b review note; screen only, the panel is never printed): the generated text sits inside one region,
       * which an AI-sourced result labels with the approved tag (ai.demoTag) and closes with the approved check line (ai.resultCheck); the
       * existing aiLabel row is kept beside the tag. The wrapper is always present (a plain container without a role for deterministic
       * output) so the live status region is never remounted. Placement and appearance: human acceptance pending.
       */}
      <div className={aiSourced ? "history-explanation-generated history-explanation-ai" : "history-explanation-generated"} {...(aiSourced ? { role: "group", "aria-labelledby": aiTagId } : {})}>
        {aiSourced ? (
          <p className="history-explanation-ai-tags">
            <span id={aiTagId} className="history-tag">
              {messages.ai.demoTag}
            </span>{" "}
            <span className="history-tag">{t.aiLabel}</span>
          </p>
        ) : null}
        <p role="status" className="history-explanation-status">
          {statusText}
        </p>
        {shown ? (
          <>
            {shown.remoteUse === "NOT_ACCEPTED" ? <p className="history-explanation-notice history-explanation-remote-use">{messages.ai.remoteNotAccepted}</p> : null}
            {/* Owner UI decision U12: only after a remote request was actually attempted and then failed or was refused. */}
            {shown.remoteUse === "UNAVAILABLE_AFTER_REQUEST" ? <p className="history-explanation-notice history-explanation-remote-use">{messages.aiHistoryFallback.unavailableAfterRequest}</p> : null}
            <p className="history-explanation-text">{shown.text.observation}</p>
            <p className="history-explanation-text">{shown.text.evidence}</p>
            {aiSourced ? <p className="history-explanation-notice history-explanation-ai-check">{messages.ai.resultCheck}</p> : null}
          </>
        ) : null}
      </div>
      {shown ? (
        <>
          <p className="history-explanation-notice">{shown.summaryRoleNotice}</p>
          {shown.limitations.map((limitation) => (
            <p key={`${limitation.limitationRef}:${limitation.code}`} className="history-note history-explanation-limitation">
              <InfoIcon size={20} />
              <span>{limitation.text}</span>
            </p>
          ))}
          <SupportingReadings messages={messages} locale={locale} view={shown.view} panelId={panelId} />
        </>
      ) : null}
    </section>
  );
}

function SupportingReadings({ messages, locale, view, panelId }: { messages: AppMessages; locale: SupportedLocale; view: ExplainablePatternView; panelId: string }) {
  const copy = useMemo(() => supportingReadingsCopy(messages, locale, view), [messages, locale, view]);
  return (
    <div className="history-explanation-supporting">
      <h4 className="history-explanation-subtitle">{copy.heading}</h4>
      {copy.periods.map((period) => {
        const headingId = `${panelId}-${period.role.toLowerCase()}`;
        return (
          <div key={period.role} className="history-explanation-period">
            <h5 id={headingId} className="history-explanation-period-title">
              {period.heading}
            </h5>
            {period.range ? <p className="history-explanation-range">{period.range}</p> : null}
            <ol className="history-explanation-readings" aria-labelledby={headingId}>
              {period.readings.map((reading) => (
                <li key={reading.key} className="history-explanation-reading">
                  <span className="history-explanation-when">{reading.when}</span> <span className="history-explanation-value">{reading.value}</span>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
      {copy.boundaryNote ? <p className="history-explanation-boundary">{copy.boundaryNote}</p> : null}
      <p className="history-explanation-reconciliation">{copy.reconciliation}</p>
    </div>
  );
}
