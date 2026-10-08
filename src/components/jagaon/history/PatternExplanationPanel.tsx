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
 */
export type PatternExplanationResult =
  | {
      kind: "EXPLAINED";
      source: "AI" | "DETERMINISTIC";
      view: ExplainablePatternView;
      composition: { taskType: string; output: { taskType: string; payload: unknown } };
      limitations: readonly { limitationRef: string; code: string; text: string }[];
      summaryRoleNotice: string;
    }
  | { kind: "UNAVAILABLE"; reason: string };

export type PatternExplainerPort = {
  explain(input: { factId: string; locale: SupportedLocale }, signal?: AbortSignal): Promise<PatternExplanationResult>;
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

/**
 * A period endpoint, derived from its instant. The home offset is the bound's own (its local wall-clock minute minus the instant's
 * minute). The time is HH:MM when the instant has no seconds or milliseconds, otherwise HH:MM:SS, floored: it never rounds up across
 * the cutoff, so "before" / "at or after" stay exact.
 */
function boundaryText(localDateText: (date: string) => string, locale: SupportedLocale, bound: PeriodBoundary): string {
  const instantMs = Date.parse(bound.instant);
  const minuteMs = Math.floor(instantMs / 60_000) * 60_000;
  const offsetMs = Date.parse(`${bound.localDate}T${bound.localTime}:00.000Z`) - minuteMs;
  const local = new Date(instantMs + offsetMs).toISOString();
  const time = instantMs === minuteMs ? local.slice(11, 16) : local.slice(11, 19);
  return dateTimeText(localDateText, locale, local.slice(0, 10), time);
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
  const cutoff = view.sharedBoundary ? boundaryText(localDateText, locale, view.sharedBoundary) : null;
  return {
    heading: t.supportingHeading(view.totalCount),
    periods: view.periods.map((period) => ({
      role: period.role,
      heading: t.periodHeading(period.role, period.count),
      range:
        cutoff === null
          ? null
          : period.role === "EARLIER"
            ? t.earlierRange(boundaryText(localDateText, locale, period.bounds.start), cutoff)
            : t.recentRange(cutoff, boundaryText(localDateText, locale, period.bounds.end)),
      readings: period.readings.map((reading) => ({
        key: `${reading.ref.recordId}:${reading.ref.revisionId}`,
        when: dateTimeText(localDateText, locale, reading.localDate, reading.localTime),
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
  return (
    <section id={panelId} className="history-explanation" aria-labelledby={headingId} aria-busy={explanation === null}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="history-explanation-title">
        {t.title}
      </h3>
      {explanation === null ? (
        <p className="history-explanation-loading">{messages.shared.loading}</p>
      ) : null}
      {shown?.source === "AI" ? <span className="history-tag">{t.aiLabel}</span> : null}
      <p role="status" className="history-explanation-status">
        {statusText}
      </p>
      {shown ? (
        <>
          <p className="history-explanation-text">{shown.text.observation}</p>
          <p className="history-explanation-text">{shown.text.evidence}</p>
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
