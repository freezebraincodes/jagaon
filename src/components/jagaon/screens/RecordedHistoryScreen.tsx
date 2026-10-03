"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type {
  HistoryComparison,
  HistoryPeriod,
  HistoryProjection,
  RecordedHistoryQueryPort,
  RecordedHistoryView,
} from "@/application/history/recorded-history-contracts";
import type { AppointmentNoteSelectionRepository } from "@/application/history/appointment-note-selection";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import {
  CalendarIcon,
  CircleIcon,
  ClipboardIcon,
  HistoryIcon,
  ListIcon,
  PencilIcon,
  PlusIcon,
  RulerIcon,
  WalkIcon,
} from "../primitives/Icons";
import { HistoryReadingsChart } from "../history/HistoryReadingsChart";
import { HistoryFactsCard, type HistoryFact } from "../history/HistoryFactsCard";
import { BookletStamps } from "../history/BookletStamps";
import { formatDateRange, formatList, formatPosition } from "../history/history-format";

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  history: RecordedHistoryQueryPort | null;
  selection: AppointmentNoteSelectionRepository;
};

const UNIT = "mmol/L";

/**
 * Recorded history (approved v1 frame 06, Packet 7A). Every statement is a
 * factual description of the journal: counts, recorded ranges, comparable
 * recorded values, repeated recorded labels, missing positions, provenance
 * and limitations. Nothing here classifies, explains, predicts or advises.
 */
export function RecordedHistoryScreen({ messages, locale, history, selection }: Props) {
  const msg = messages.history;
  const [period, setPeriod] = useState<HistoryPeriod>("THIS_WEEK");
  const [view, setView] = useState<RecordedHistoryView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!history) return;
    const request = latestRequest.current + 1;
    latestRequest.current = request;
    void Promise.resolve()
      .then(() => {
        if (latestRequest.current === request) setView(null);
        return history.load({ period });
      })
      .then((next) => {
        if (latestRequest.current !== request) return;
        setView(next);
        setStatus(null);
        setSelecting(false);
        const range = next.status === "UNAVAILABLE" ? null : next.status === "EMPTY" ? next.range : next.projection.range;
        setSelected(new Set(range ? selection.selectedFor(period, range.startDate) : []));
      })
      .catch(() => {
        if (latestRequest.current === request) setView({ status: "UNAVAILABLE", code: "STORAGE_UNAVAILABLE" });
      });
  }, [history, period, attempt, selection]);

  const projection: HistoryProjection | null =
    view && (view.status === "READY" || view.status === "INSUFFICIENT_EVIDENCE") ? view.projection : null;
  const comparisons = useMemo<HistoryComparison[]>(() => (view?.status === "READY" ? view.comparisons : []), [view]);
  const range = projection?.range ?? (view?.status === "EMPTY" ? view.range : null);
  const rangeText = range ? formatDateRange(locale, range.startDate, range.endDate) : "";

  const facts = useMemo<HistoryFact[]>(() => {
    if (!projection) return [];
    const list: HistoryFact[] = [
      { id: "READING_COUNT", text: msg.readingCount(projection.readingCount, rangeText), icon: <ListIcon size={22} /> },
    ];
    if (projection.valueRange) {
      list.push({
        id: "VALUE_RANGE",
        text: msg.valueRange(projection.valueRange.minimum, projection.valueRange.maximum, UNIT),
        icon: <RulerIcon size={22} />,
      });
    }
    for (const comparison of comparisons) {
      const slot = msg.slotLabels[comparison.slot];
      const text =
        comparison.kind === "HIGHER"
          ? msg.comparisonHigher(slot, comparison.recent ?? "", comparison.reference ?? "", UNIT)
          : comparison.kind === "LOWER"
            ? msg.comparisonLower(slot, comparison.recent ?? "", comparison.reference ?? "", UNIT)
            : comparison.kind === "VARIABILITY"
              ? msg.comparisonVariability(slot, comparison.recent ?? "", comparison.reference ?? "", UNIT)
              : msg.noMaterialComparison(slot);
      list.push({
        id: comparison.factId,
        text,
        icon: <HistoryIcon size={22} />,
        details: [
          msg.evidenceWindow(
            formatDateRange(locale, comparison.recentWindow.startDate, comparison.recentWindow.endDate),
            formatDateRange(locale, comparison.referenceWindow.startDate, comparison.referenceWindow.endDate),
          ),
          ...(comparison.correctionUpdated ? [msg.correctionUpdated] : []),
        ],
      });
    }
    for (const entry of projection.slotCounts) {
      list.push({ id: `SLOT_COUNT:${entry.slot}`, text: msg.slotCount(msg.slotLabels[entry.slot], entry.count), icon: <CalendarIcon size={22} /> });
    }
    for (const entry of projection.repeated) {
      list.push({
        id: entry.factId,
        text: entry.kind === "ITEM" ? msg.repeatedItem(entry.label, entry.count, entry.days) : msg.repeatedContext(entry.label, entry.count, entry.days),
        icon: entry.kind === "ITEM" ? <PencilIcon size={22} /> : <WalkIcon size={22} />,
      });
    }
    if (projection.notRecordedPositions.length > 0) {
      const names = projection.notRecordedPositions.map((position) =>
        formatPosition(locale, position.date, position.position, projection.period, msg.positionLabels),
      );
      list.push({
        id: "NOT_RECORDED_POSITIONS",
        text: names.length === 1 ? msg.notRecordedPosition(names[0]!) : msg.notRecordedPositions(formatList(locale, names)),
        icon: <CircleIcon size={22} />,
      });
    }
    list.push({ id: "SOURCE", text: msg.sourceSummary(msg.sourcePatientEntered), icon: <ClipboardIcon size={22} /> });
    if (projection.correctedRecordCount > 0) {
      list.push({ id: "CORRECTIONS", text: msg.correctionSummary(projection.correctedRecordCount), icon: <PencilIcon size={22} /> });
    }
    // Only facts the port declared selectable are offered.
    return list.filter((fact) => projection.selectableFactIds.includes(fact.id));
  }, [projection, comparisons, msg, locale, rangeText]);

  const persist = useCallback(
    (ids: Set<string>) => {
      if (!range) return;
      const ordered = facts.map((fact) => fact.id).filter((id) => ids.has(id));
      const result = selection.save({ period, startDate: range.startDate, endDate: range.endDate, factIds: ordered });
      setSelected(new Set(ordered));
      setStatus(result.ok ? msg.selectionSaved : msg.unavailableBody);
    },
    [facts, msg, period, range, selection],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
    },
    [persist, selected],
  );

  return (
    <div className="history-screen">
      <h1 className="screen-title">{msg.title}</h1>
      <ChoiceGroup
        legend={msg.title}
        legendHidden
        variant="segmented"
        value={period}
        onChange={setPeriod}
        options={[
          { value: "THIS_WEEK", label: msg.periodThisWeek },
          { value: "LAST_WEEK", label: msg.periodLastWeek },
          { value: "THIRTY_DAYS", label: msg.periodThirtyDays },
        ]}
      />
      {range ? <p className="history-range">{msg.periodRange(rangeText)}</p> : null}

      {!history || view === null ? (
        <p role="status" className="history-loading">
          {msg.loading}
        </p>
      ) : view.status === "UNAVAILABLE" ? (
        <section className="today-card history-state" aria-labelledby="history-unavailable-heading">
          <h2 id="history-unavailable-heading" className="card-title">
            {msg.unavailableTitle}
          </h2>
          <p>{msg.unavailableBody}</p>
          <button type="button" className="btn btn-outline btn-wide" onClick={() => setAttempt((value) => value + 1)}>
            {msg.retry}
          </button>
        </section>
      ) : view.status === "EMPTY" ? (
        <section className="today-card history-state" aria-labelledby="history-empty-heading">
          <h2 id="history-empty-heading" className="card-title">
            {msg.emptyTitle}
          </h2>
          <p>{msg.emptyBody}</p>
        </section>
      ) : projection ? (
        <>
          {view.status === "INSUFFICIENT_EVIDENCE" ? (
            <div className="history-insufficient">
              <p className="history-insufficient-title">{msg.insufficientTitle}</p>
              <p>{msg.insufficientBody}</p>
            </div>
          ) : null}
          <section className="today-card history-readings" aria-labelledby="history-readings-heading">
            <h2 id="history-readings-heading" className="card-title">
              {msg.readingsTitle(UNIT)}
            </h2>
            <HistoryReadingsChart
              messages={messages}
              locale={locale}
              period={projection.period}
              chart={projection.chart}
              headingId="history-readings-heading"
            />
          </section>
          <HistoryFactsCard
            messages={messages}
            rangeText={rangeText}
            facts={facts}
            notes={[
              ...(view.unavailableFamilies.length > 0 ? [msg.familyUnavailable] : []),
              msg.nonCausalLimitation,
            ]}
            selecting={selecting}
            selected={selected}
            onToggle={toggle}
          >
            <span className="history-tag history-tag--action">{msg.actionsTag}</span>
            <button
              type="button"
              className="btn btn-outline btn-wide history-add-facts"
              onClick={() => persist(new Set(facts.map((fact) => fact.id)))}
            >
              <PlusIcon size={24} />
              {msg.addFacts}
            </button>
          </HistoryFactsCard>
          <BookletStamps messages={messages} locale={locale} stamps={projection.stamps} />
          <button
            type="button"
            className="btn btn-outline btn-wide history-select-facts"
            aria-pressed={selecting}
            onClick={() => setSelecting((value) => !value)}
          >
            <ListIcon size={24} />
            {msg.selectFacts}
          </button>
          {status ? (
            <p role="status" className="history-status">
              {status}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="history-note history-note--footer">{msg.loggingLimitation}</p>
    </div>
  );
}
