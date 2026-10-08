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
import { PatternExplanationPanel, type PatternExplainerPort, type PatternExplanationResult } from "../history/PatternExplanationPanel";

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  history: RecordedHistoryQueryPort | null;
  selection: AppointmentNoteSelectionRepository;
  /**
   * Packet 11C Task 7: the pattern-explanation use case (`createPatternExplainer`). Without it no explanation action is offered and
   * no source projection is probed.
   */
  explainer?: PatternExplainerPort | null;
};

/** One opened explanation: `nonce` makes every opening its own request. */
type OpenExplanation = { factId: string; nonce: number };

const panelIdFor = (factId: string) => `history-explanation-${factId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

const UNIT = "mmol/L";

/**
 * Recorded history (approved v1 frame 06, Packet 7A). Every statement is a
 * factual description of the journal: counts, recorded ranges, comparable
 * recorded values, repeated recorded labels, missing positions, provenance
 * and limitations. The 7A facts never classify, explain a cause, predict or
 * advise. Packet 11C Task 7: when an `explainer` is supplied, an explainable
 * comparison also offers a panel that shows how that comparison was worked
 * out (its explanation, summary-role line, limitation and every supporting
 * reading by period); it describes the records, never a cause, and leaves
 * the 7A fact text unchanged.
 */
export function RecordedHistoryScreen({ messages, locale, history, selection, explainer = null }: Props) {
  const msg = messages.history;
  const [period, setPeriod] = useState<HistoryPeriod>("THIS_WEEK");
  const [view, setView] = useState<RecordedHistoryView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const latestRequest = useRef(0);
  // Packet 11C Task 7: the load that produced `view`, the comparisons it can explain, the opened explanation and its answer.
  const [viewToken, setViewToken] = useState(0);
  const [explainable, setExplainable] = useState<{ token: number; ids: ReadonlySet<string> }>({ token: -1, ids: new Set() });
  const [opened, setOpened] = useState<OpenExplanation | null>(null);
  const [answer, setAnswer] = useState<{ key: string; explanation: PatternExplanationResult } | null>(null);
  const [openings, setOpenings] = useState(0);

  /**
   * Packet 11C B2b (carried Checkpoint 2 minor): focus is never dropped when the panel or a fact card that holds it is removed by a
   * period change or a reload. Right before such an update, focus inside the screen but outside the period control is noted; once the
   * update has removed that element, focus moves to the checked period option (the control the patient changes periods with). Focus
   * that survives the update, or that is already on the period control, stays where it is.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const focusToPeriod = useRef(false);
  const noteFocusBeforeRemoval = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active) && !active.closest("fieldset")) focusToPeriod.current = true;
  }, []);
  useEffect(() => {
    if (!focusToPeriod.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) {
      focusToPeriod.current = false;
      return;
    }
    focusToPeriod.current = false;
    rootRef.current?.querySelector<HTMLInputElement>("fieldset input:checked")?.focus();
  });

  useEffect(() => {
    if (!history) return;
    const request = latestRequest.current + 1;
    latestRequest.current = request;
    void Promise.resolve()
      .then(() => {
        if (latestRequest.current === request) {
          noteFocusBeforeRemoval();
          setView(null);
        }
        return history.load({ period });
      })
      .then((next) => {
        if (latestRequest.current !== request) return;
        setView(next);
        setViewToken(request);
        setOpened(null);
        setStatus(null);
        setSelecting(false);
        const range = next.status === "UNAVAILABLE" ? null : next.status === "EMPTY" ? next.range : next.projection.range;
        setSelected(new Set(range ? selection.selectedFor(period, range.startDate) : []));
      })
      .catch(() => {
        if (latestRequest.current === request) setView({ status: "UNAVAILABLE", code: "STORAGE_UNAVAILABLE" });
      });
  }, [history, period, attempt, selection, noteFocusBeforeRemoval]);

  const projection: HistoryProjection | null =
    view && (view.status === "READY" || view.status === "INSUFFICIENT_EVIDENCE") ? view.projection : null;
  const comparisons = useMemo<HistoryComparison[]>(() => (view?.status === "READY" ? view.comparisons : []), [view]);

  // Packet 11C Task 7: ask the source projection which comparisons can be explained (only when an explainer is supplied).
  useEffect(() => {
    if (!history || !explainer) return;
    const candidates = comparisons.filter((comparison) => comparison.kind !== "NO_MATERIAL").map((comparison) => comparison.factId);
    if (candidates.length === 0) return;
    const token = viewToken;
    let live = true;
    void Promise.all(
      candidates.map((factId) =>
        history.loadExplainablePattern({ factId }).then(
          (result) => (result.kind === "EXPLAINABLE" ? factId : null),
          () => null,
        ),
      ),
    ).then((ids) => {
      if (!live) return;
      // A comparison that is no longer explainable loses its action (and an open panel); focus there is not dropped.
      noteFocusBeforeRemoval();
      setExplainable({ token, ids: new Set(ids.filter((id): id is string => id !== null)) });
    });
    return () => {
      live = false;
    };
  }, [history, explainer, comparisons, viewToken, noteFocusBeforeRemoval]);

  /**
   * The answer to the opened explanation. Every request carries a key (view load, fact, opening, locale). A request is aborted when any
   * of these changes or the screen unmounts, and an answer is shown only while its key is still the current one — checked at render
   * time, so a late answer is discarded even if it lands before React has run the cleanup of the commit that superseded it.
   */
  const answerKey = explainer && opened ? `${viewToken}|${opened.factId}|${opened.nonce}|${locale}` : null;
  useEffect(() => {
    if (!explainer || !opened) return;
    const key = `${viewToken}|${opened.factId}|${opened.nonce}|${locale}`;
    const controller = new AbortController();
    explainer.explain({ factId: opened.factId, locale }, controller.signal).then(
      (explanation) => {
        if (!controller.signal.aborted) setAnswer({ key, explanation });
      },
      () => {
        if (!controller.signal.aborted) setAnswer({ key, explanation: { kind: "UNAVAILABLE", reason: "UNAVAILABLE" } });
      },
    );
    return () => controller.abort();
  }, [explainer, opened, locale, viewToken]);
  const currentAnswer = answerKey !== null && answer?.key === answerKey ? answer.explanation : null;
  const explainableIds = explainable.token === viewToken ? explainable.ids : null;

  /**
   * Packet 11C B2b (carried Checkpoint 2 minor): a STALE_RESULT means a supporting record changed after the card was loaded, so the 7A
   * card is reloaded once for that answer: a local history read only. The view token is kept, so the open panel keeps its stale
   * message and nothing is explained again until the patient reopens the comparison. If the comparison is gone from the reloaded
   * view, the panel closes and the stale message moves to the screen's status line.
   */
  const staleReloadedFor = useRef<string | null>(null);
  const staleFactId = currentAnswer?.kind === "UNAVAILABLE" && currentAnswer.reason === "STALE_RESULT" && opened ? opened.factId : null;
  useEffect(() => {
    if (!history || staleFactId === null || answerKey === null || staleReloadedFor.current === answerKey) return;
    staleReloadedFor.current = answerKey;
    const request = latestRequest.current + 1;
    latestRequest.current = request;
    void history.load({ period }).then(
      (next) => {
        if (latestRequest.current !== request) return;
        noteFocusBeforeRemoval();
        setView(next);
        if (next.status !== "READY" || !next.comparisons.some((comparison) => comparison.factId === staleFactId)) {
          setOpened(null);
          setStatus(msg.explanation.stale);
        }
      },
      () => undefined,
    );
  }, [history, period, staleFactId, answerKey, msg, noteFocusBeforeRemoval]);

  const toggleExplanation = useCallback(
    (factId: string) => {
      if (opened?.factId === factId) {
        setOpened(null);
        return;
      }
      const nonce = openings + 1;
      setOpenings(nonce);
      setOpened({ factId, nonce });
    },
    [opened, openings],
  );

  const changePeriod = useCallback(
    (next: HistoryPeriod) => {
      noteFocusBeforeRemoval();
      setOpened(null);
      setPeriod(next);
    },
    [noteFocusBeforeRemoval],
  );
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
    <div className="history-screen" ref={rootRef}>
      <h1 className="screen-title">{msg.title}</h1>
      <ChoiceGroup
        legend={msg.title}
        legendHidden
        variant="segmented"
        value={period}
        onChange={changePeriod}
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
            facts={facts.map((fact) => {
              if (!explainer || !explainableIds?.has(fact.id)) return fact;
              const isOpen = opened?.factId === fact.id;
              const panelId = panelIdFor(fact.id);
              return {
                ...fact,
                extra: (
                  <>
                    <button
                      type="button"
                      className="btn btn-outline btn-wide history-explain-action"
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? panelId : undefined}
                      onClick={() => toggleExplanation(fact.id)}
                    >
                      {msg.explanation.action}
                    </button>
                    {isOpen && opened ? (
                      <PatternExplanationPanel
                        key={opened.nonce}
                        messages={messages}
                        locale={locale}
                        explanation={currentAnswer}
                        panelId={panelId}
                      />
                    ) : null}
                  </>
                ),
              };
            })}
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
