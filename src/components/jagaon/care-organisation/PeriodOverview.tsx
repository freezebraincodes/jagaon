"use client";

import { useId, useMemo } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { CareOrganisationQueryPort, OverviewPeriodChoice, PeriodOverviewView } from "@/application/care-organisation/care-organisation-contracts";
import { ChoiceGroup, type ChoiceOption } from "../primitives/ChoiceGroup";
import { formatLocalDate } from "./care-format";
import { useCareLoad } from "./use-care-load";

type ReadyOverview = Extract<PeriodOverviewView, { status: "READY" }>;

/** The days each fixed choice counts back from today. */
const PERIOD_DAYS: Record<Exclude<OverviewPeriodChoice, "SINCE_LAST_VISIT">, number> = { LAST_7_DAYS: 7, LAST_14_DAYS: 14, LAST_30_DAYS: 30 };

/**
 * Owner decision 2026-10-16: the plain-count sentences for one overview, e.g. "In the last 30 days you logged 84 glucose readings,
 * 80 meals and 18 walks." A kind with no records is left out rather than shown as 0; nothing is judged or compared.
 */
export function periodOverviewSentences(messages: AppMessages, locale: SupportedLocale, view: ReadyOverview): string[] {
  const copy = messages.carePreparation;
  const opening =
    view.choice === "SINCE_LAST_VISIT" && view.lastVisit ? copy.overviewSinceVisit(formatLocalDate(locale, view.lastVisit.localDate)) : copy.overviewInLastDays(PERIOD_DAYS[view.choice as keyof typeof PERIOD_DAYS] ?? 30);
  const parts = [
    view.counts.GLUCOSE > 0 ? copy.overviewGlucose(view.counts.GLUCOSE) : null,
    view.counts.MEALS > 0 ? copy.overviewMeals(view.counts.MEALS) : null,
    view.counts.INSULIN > 0 ? copy.overviewInsulin(view.counts.INSULIN) : null,
    view.counts.WALKS > 0 ? copy.overviewWalks(view.counts.WALKS) : null,
  ].filter((part): part is string => part !== null);
  const logged = parts.length > 0 ? copy.overviewLogged(opening, new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts)) : copy.overviewNothingLogged(opening);
  const questions = view.questionCount > 0 ? (view.questionsFor ? copy.overviewQuestionsFor(view.questionCount, view.questionsFor) : copy.overviewQuestions(view.questionCount)) : null;
  return questions ? [logged, questions] : [logged];
}

/**
 * Owner decision 2026-10-16: one overview block of plain counts for the chosen period. With `onChoiceChange` it offers the period
 * choice ("Since your last visit" only when a visit the patient reported attending is on record); without it, it only shows the
 * counts. The choice never changes the visit summary's own period. Without the overview query nothing is shown.
 */
export function PeriodOverview({
  messages,
  locale,
  query,
  choice,
  onChoiceChange,
  refreshKey,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  query: Pick<CareOrganisationQueryPort, "loadPeriodOverview"> | null;
  choice: OverviewPeriodChoice;
  onChoiceChange?: (choice: OverviewPeriodChoice) => void;
  /** A change (for example a reloaded screen view) counts again. */
  refreshKey?: unknown;
}) {
  const copy = messages.carePreparation;
  const headingId = useId();
  const available = Boolean(query?.loadPeriodOverview);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey only asks for a fresh count.
  const loader = useMemo(() => (query?.loadPeriodOverview ? () => query.loadPeriodOverview!(choice) : null), [query, choice, refreshKey]);
  const { value: view } = useCareLoad<PeriodOverviewView>(loader, { status: "UNAVAILABLE" });
  if (!available) return null;
  const ready = view?.status === "READY" ? view : null;
  if (view !== null && !ready) return null;

  const options: ChoiceOption<OverviewPeriodChoice>[] = [
    { value: "LAST_7_DAYS", label: copy.periodLast7Days },
    { value: "LAST_14_DAYS", label: copy.periodLast14Days },
    { value: "LAST_30_DAYS", label: copy.periodLast30Days },
    ...(ready?.lastVisit ? [{ value: "SINCE_LAST_VISIT" as const, label: copy.periodSinceLastVisit }] : []),
  ];

  return (
    <section className="care-overview" aria-labelledby={headingId}>
      <h2 className="eyebrow" id={headingId}>
        {copy.overviewHeading}
      </h2>
      {onChoiceChange && ready ? <ChoiceGroup legend={copy.overviewPeriodLegend} legendHidden variant="segmented" value={ready.choice} onChange={onChoiceChange} options={options} /> : null}
      <div className="care-overview-text" aria-live="polite">
        {ready ? periodOverviewSentences(messages, locale, ready).map((sentence) => <p key={sentence}>{sentence}</p>) : <p>{copy.overviewLoading}</p>}
      </div>
    </section>
  );
}
