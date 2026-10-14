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
import { AiDisclosureDialog } from "../ai/AiDisclosureDialog";
import { HabitTrendPreviewCard } from "../history/HabitTrendPreviewCard";
import type { PreviewInsightsQueryPort } from "@/application/preview/preview-insights-contracts";

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
  /**
   * HSA-bounded mode PREVIEW (owner decision 2026-10-14): read only while the mode is off, for the "What changed alongside" card.
   * Without it (or while the mode is on) History is unchanged.
   */
  previewInsights?: PreviewInsightsQueryPort | null;
};

/**
 * One opened explanation: `nonce` makes every opening its own request. `locale` is the locale it was opened in (Packet 11C B4a: a
 * locale switch closes it). `decision` (Packet 11C Addendum C, C3) is the patient's answer to the AI disclosure shown for THIS opening
 * ("DECLINED": Cancel or Escape, explained with the standard wording; "ACCEPTED": the dialog's primary action), or null when no
 * disclosure was shown. It travels with this one request only.
 */
type OpenExplanation = { factId: string; nonce: number; locale: SupportedLocale; decision: "ACCEPTED" | "DECLINED" | null };
/**
 * Packet 11C B3: the AI disclosure shown for one comparison, valid only for the view load and locale it was asked in. `locale` (Packet
 * 11C Addendum C, C5): the locale of the explicit request it belongs to, named by its audit row if it closes as moot.
 */
type PendingDisclosure = { factId: string; key: string; locale: SupportedLocale };

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
export function RecordedHistoryScreen({ messages, locale, history, selection, explainer = null, previewInsights = null }: Props) {
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
  /**
   * Packet 11C B4a (B3 carry, before any activation): a locale switch CLOSES an open explanation; it is never explained again in the new
   * locale by itself (that would be a new request, possibly a new POST, without the patient asking). Closing it here, during render,
   * means the switched commit never runs the request effect for it; the pending request is aborted by the effect cleanup and its late
   * answer is discarded by the key check. A new explicit action in the new locale is required.
   */
  if (opened !== null && opened.locale !== locale) setOpened(null);
  const answerKey = explainer && opened ? `${viewToken}|${opened.factId}|${opened.nonce}|${locale}` : null;
  useEffect(() => {
    if (!explainer || !opened || opened.locale !== locale) return;
    const key = `${viewToken}|${opened.factId}|${opened.nonce}|${locale}`;
    // Packet 11C Addendum C (C3): this request's own signal is its decision token; aborting it (a new opening, a view, period or locale
    // change, unmount) ends the decision, and the decision is never reused for another request.
    const controller = new AbortController();
    const input = opened.decision ? { factId: opened.factId, locale, disclosure: opened.decision } : { factId: opened.factId, locale };
    explainer.explain(input, controller.signal).then(
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

  /**
   * Packet 11C Addendum B, Task B3: the AI disclosure is decided here, on the patient's action and BEFORE the explainer is called (so
   * before the hybrid service and its timers), never while NOT_ACTIVATED. Cancel or Escape opens the explanation composed
   * deterministically with nothing sent. A view reload, period change or locale change while it is open makes the request moot: the
   * disclosure closes, nothing is explained, and it does not come back.
   * Packet 11C Addendum C, Task C3 (owner decision: acceptance is per explicit request): the dialog is shown for THIS request only when
   * the explainer says a remote attempt could actually happen for it (its own class qualified, activated, online). Accepting opens the
   * explanation with that one request's acceptance; nothing is remembered, so the next action (another comparison, the same one again,
   * after a locale, period or view change) asks again.
   */
  const [pendingDisclosure, setPendingDisclosure] = useState<PendingDisclosure | null>(null);
  const disclosureKey = `${viewToken}|${locale}`;
  if (pendingDisclosure !== null && pendingDisclosure.key !== disclosureKey) setPendingDisclosure(null);
  const shownDisclosure = explainer && pendingDisclosure?.key === disclosureKey ? pendingDisclosure : null;

  /**
   * Packet 11C Addendum C, Task C3: the action the patient just took, waiting for its per-request disclosure check (one local read). A
   * newer action, a view reload, a period or locale change or the screen closing supersedes a check still in flight: its answer is
   * ignored, so nothing opens and no dialog appears by itself.
   */
  const [pendingCheck, setPendingCheck] = useState<PendingDisclosure | null>(null);
  if (pendingCheck !== null && pendingCheck.key !== disclosureKey) setPendingCheck(null);

  /**
   * Packet 11C Addendum C, Task C5: the request behind a disclosure that closes without the patient's decision (a view reload, period or
   * locale change, or the screen closing) is moot, and it still writes its one audit row (DISCLOSURE_CLOSED_MOOT; nothing is sent). A
   * disclosure the patient answered is marked decided first, so it never also counts as moot. A cleanup that is immediately followed by
   * the same dialog's effect again (a new explainer identity, or a development StrictMode remount) is not a close: the report is decided
   * one microtask later, only if that dialog is no longer the live one.
   */
  const decidedDisclosures = useRef(new WeakSet<PendingDisclosure>());
  const liveDisclosure = useRef<PendingDisclosure | null>(null);
  useEffect(() => {
    if (!shownDisclosure || !explainer) return;
    const shown = shownDisclosure;
    const decided = decidedDisclosures.current;
    const live = liveDisclosure;
    const report = explainer.disclosureClosed?.bind(explainer);
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
  }, [shownDisclosure, explainer]);

  const openExplanation = useCallback(
    (factId: string, decision: "ACCEPTED" | "DECLINED" | null = null) => {
      const nonce = openings + 1;
      setOpenings(nonce);
      setOpened({ factId, nonce, locale, decision });
    },
    [openings, locale],
  );

  /**
   * Packet 11C Addendum C (C3): the check is asked for THIS request (this comparison, in this locale); a failure counts as "not required".
   * Its effect is cleaned up (so its answer no longer opens anything) when a newer action replaces it, the key changes or the screen
   * closes. C3 fix round 1: the click was an explicit request, so a superseded check still ends in exactly ONE zero-attempt audit row,
   * decided by what the check answers: DISCLOSURE_CLOSED_MOOT when a disclosure would have been needed (the request closed without the
   * patient's decision, as for a moot dialog), otherwise REQUEST_CANCELLED (written by the use case for a request whose signal is already
   * aborted: no read, no send). A rerun of the same check (a new explainer identity or a development StrictMode remount) is not a
   * supersession: only the run that acts on a check, or the one that reports it, handles it, and each check is handled once.
   */
  const handledChecks = useRef(new WeakSet<PendingDisclosure>());
  const liveCheck = useRef<PendingDisclosure | null>(null);
  useEffect(() => {
    if (!pendingCheck || !explainer) return;
    const check = pendingCheck;
    const handled = handledChecks.current;
    const live = liveCheck;
    const port = explainer;
    const required = port.disclosureRequired;
    live.current = check;
    let active = true;
    void Promise.resolve()
      .then(() => (required ? required.call(port, { factId: check.factId, locale: check.locale }) : false))
      .then(
        (value) => value === true,
        () => false,
      )
      .then((needed) => {
        if (handled.has(check)) return;
        if (active) {
          handled.add(check);
          setPendingCheck(null);
          if (needed) setPendingDisclosure(check);
          else openExplanation(check.factId);
          return;
        }
        // Another run of this same check is still live and will act on it.
        if (live.current === check) return;
        handled.add(check);
        if (needed) return void Promise.resolve().then(() => port.disclosureClosed?.({ locale: check.locale })).catch(() => undefined);
        const cancelled = new AbortController();
        cancelled.abort();
        return void Promise.resolve().then(() => port.explain({ factId: check.factId, locale: check.locale }, cancelled.signal)).catch(() => undefined);
      });
    return () => {
      active = false;
      if (live.current === check) live.current = null;
    };
  }, [pendingCheck, explainer, openExplanation]);

  const toggleExplanation = useCallback(
    (factId: string) => {
      setPendingCheck(null);
      if (opened?.factId === factId) {
        setOpened(null);
        return;
      }
      if (!explainer?.disclosureRequired) {
        openExplanation(factId);
        return;
      }
      // C3 fix round 1: a new click ends the previous request at once (its effect aborts it, so its decision ends) before this
      // request's own check settles.
      setOpened(null);
      setPendingCheck({ factId, key: disclosureKey, locale });
    },
    [opened, explainer, disclosureKey, openExplanation, locale],
  );

  // Packet 11C Addendum C (C3): the primary action accepts remote use for this one request only (it travels with it, and nothing else
  // is accepted or remembered).
  const acceptDisclosure = useCallback(() => {
    if (!shownDisclosure) return;
    decidedDisclosures.current.add(shownDisclosure);
    setPendingDisclosure(null);
    openExplanation(shownDisclosure.factId, "ACCEPTED");
  }, [shownDisclosure, openExplanation]);

  // Packet 11C B4a: an explicit decline is passed with the request (audited REMOTE_USE_DECLINED since C5; nothing is sent).
  const cancelDisclosure = useCallback(() => {
    if (!shownDisclosure) return;
    decidedDisclosures.current.add(shownDisclosure);
    setPendingDisclosure(null);
    openExplanation(shownDisclosure.factId, "DECLINED");
  }, [shownDisclosure, openExplanation]);

  const changePeriod = useCallback(
    (next: HistoryPeriod) => {
      noteFocusBeforeRemoval();
      setOpened(null);
      setPendingCheck(null);
      setPendingDisclosure(null);
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
        <>
          <section className="today-card history-state" aria-labelledby="history-empty-heading">
            <h2 id="history-empty-heading" className="card-title">
              {msg.emptyTitle}
            </h2>
            <p>{msg.emptyBody}</p>
          </section>
          <HabitTrendPreviewCard messages={messages} previewInsights={previewInsights} />
        </>
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
          <HabitTrendPreviewCard messages={messages} previewInsights={previewInsights} />
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
      {shownDisclosure ? <AiDisclosureDialog messages={messages} flow="PATTERN" passcode={explainer?.accessPasscode ?? null} onConfirm={acceptDisclosure} onCancel={cancelDisclosure} /> : null}
    </div>
  );
}
