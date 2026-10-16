"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { CareOrganisationCommandPort, CareOrganisationCommitResult } from "@/application/care-organisation/care-organisation-contracts";
import type { CareOrganisationQueryPort, CareQuestionView, FactGroupKey, FactGroupView, OverviewPeriodChoice, VisitPreparationView } from "@/application/care-organisation/care-organisation-contracts";
import { ScreenHeader } from "../primitives/ScreenHeader";
import {
  BookIcon,
  ChartIcon,
  CheckIcon,
  ChevronRightIcon,
  DocumentIcon,
  EyeIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  ShareIcon,
  ShieldIcon,
  TrashIcon,
} from "../primitives/Icons";
import { AppointmentEditor, type AppointmentEditorResult } from "../care-organisation/AppointmentEditor";
import { CareQuestionEditor } from "../care-organisation/CareQuestionEditor";
import { PeriodOverview } from "../care-organisation/PeriodOverview";
import { daysBetween, formatLocalDate, formatMonthShort, formatPointTime, formatWeekday, localDateOfPoint } from "../care-organisation/care-format";
import { useCareLoad } from "../care-organisation/use-care-load";

type ReadyView = Extract<VisitPreparationView, { status: "READY" }>;

/** The patient's explicit choice: only ticked, non-empty groups and ticked questions. */
export type CarePreparationSelection = {
  period: ReadyView["period"];
  /** The appointment shown on this screen, which the summary is prepared for. */
  appointment: ReadyView["appointment"];
  factGroups: FactGroupView[];
  questions: CareQuestionView[];
  /** Shown but unticked candidates; kept local and never exported. */
  notSelected: Array<FactGroupView["sources"][number] | { recordType: "CARE_QUESTION"; recordId: CareQuestionView["recordId"]; revisionId: CareQuestionView["revisionId"] }>;
};

type ScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  query: CareOrganisationQueryPort | null;
  commands: CareOrganisationCommandPort | null;
  /** Packet 9C preview hand-off; resolves false when nothing was prepared. */
  onPreview?: (selection: CarePreparationSelection) => Promise<boolean>;
  /** Owner decision 2026-10-16: the overview's period, kept by the app so the summary preview shows the same one. */
  overviewPeriod?: OverviewPeriodChoice;
  onOverviewPeriodChange?: (choice: OverviewPeriodChoice) => void;
};

/** Owner decision 2026-10-16: the overview counts the last 30 days until the patient picks another period. */
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriodChoice = "LAST_30_DAYS";

type Dialog = { kind: "APPOINTMENT" } | { kind: "ADD_QUESTION" } | { kind: "EDIT_QUESTION"; recordId: string } | null;

const langOf = (language: string) => (language === "und" ? undefined : language);

/**
 * Screen 10 — Prepare for my visit. Shows the appointment the patient
 * entered, lets them tick factual record groups and their own questions,
 * and never answers, sends or interprets anything.
 */
export function CarePreparationScreen({ messages, locale, query, commands, onPreview, overviewPeriod, onOverviewPeriodChange }: ScreenProps) {
  const copy = messages.carePreparation;
  const loader = useMemo(() => (query ? () => query.loadVisitPreparation() : null), [query]);
  const { value: view, reload } = useCareLoad<VisitPreparationView>(loader, { status: "UNAVAILABLE" });
  const [selectedGroups, setSelectedGroups] = useState<ReadonlySet<FactGroupKey>>(new Set());
  const [selectedQuestions, setSelectedQuestions] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rowFailure, setRowFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [ownOverviewPeriod, setOwnOverviewPeriod] = useState<OverviewPeriodChoice>(DEFAULT_OVERVIEW_PERIOD);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function commit(write: () => Promise<CareOrganisationCommitResult>, { inDialog, failureKey }: { inDialog: boolean; failureKey?: string }) {
    setBusy(true);
    setFailed(false);
    setRowFailure(null);
    setAnnouncement("");
    const result = await write();
    if (!mounted.current) return;
    setBusy(false);
    if (result.kind !== "COMMITTED") {
      if (inDialog) setFailed(true);
      else setRowFailure(failureKey ?? null);
      reload();
      return;
    }
    if (inDialog) setDialog(null);
    setAnnouncement(copy.saved);
    reload();
  }

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setFailed(false);
  }

  const ready = view?.status === "READY" ? view : null;
  const appointment = ready?.appointment ?? null;
  // Selection only ever names groups and questions still present in the latest view.
  const selection: CarePreparationSelection | null = ready
    ? {
        period: ready.period,
        appointment: ready.appointment,
        factGroups: ready.factGroups.filter((group) => selectedGroups.has(group.key) && group.sources.length > 0),
        questions: ready.questions.filter((question) => selectedQuestions.has(question.recordId)),
        notSelected: [
          ...ready.factGroups.filter((group) => !selectedGroups.has(group.key)).flatMap((group) => group.sources),
          ...ready.questions
            .filter((question) => !selectedQuestions.has(question.recordId))
            .map((question) => ({ recordType: "CARE_QUESTION" as const, recordId: question.recordId, revisionId: question.revisionId })),
        ],
      }
    : null;

  async function preview() {
    if (!selection || !onPreview) return;
    setBusy(true);
    setPreviewFailed(false);
    const prepared = await onPreview(selection);
    if (!mounted.current) return;
    setBusy(false);
    // Nothing is claimed prepared; the selections stay as they are.
    if (!prepared) setPreviewFailed(true);
  }
  const selectedCount = selection ? selection.factGroups.length + selection.questions.length : 0;
  const editingQuestion = dialog?.kind === "EDIT_QUESTION" ? (ready?.questions.find((question) => question.recordId === dialog.recordId) ?? null) : null;

  function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function saveAppointment(result: AppointmentEditorResult) {
    if (!commands) return;
    if (result.kind === "CREATE") {
      void commit(() => commands.scheduleAppointment({ payload: result.payload, scheduledAt: result.scheduledAt }), { inDialog: true });
      return;
    }
    if (!appointment) return;
    void commit(
      () =>
        commands.reviseAppointment({
          recordId: appointment.recordId,
          expectedRevisionId: appointment.revisionId,
          expectedRevisionNumber: appointment.revisionNumber,
          payload: result.payload,
          scheduledAt: result.scheduledAt,
          reason: result.reason,
        }),
      { inDialog: true },
    );
  }

  // Owner decision 2026-10-16: the title names who the recorded appointment is with, as the patient entered it.
  const title = appointment ? copy.titleWithDoctor(appointment.payload.careContactLabel ?? appointment.payload.appointmentLabel) : copy.title;

  return (
    <div className="care-preparation">
      <ScreenHeader title={title} />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {view === null ? <p className="care-loading">{copy.loading}</p> : null}
      {view?.status === "UNAVAILABLE" ? (
        <div className="banner banner-error" role="alert">
          <p className="banner-title">{copy.unavailableTitle}</p>
        </div>
      ) : null}

      {ready ? (
        <>
          <PeriodOverview
            messages={messages}
            locale={locale}
            query={query}
            choice={overviewPeriod ?? ownOverviewPeriod}
            onChoiceChange={(choice) => {
              setOwnOverviewPeriod(choice);
              onOverviewPeriodChange?.(choice);
            }}
            refreshKey={view}
          />

          {appointment ? (
            <AppointmentCard messages={messages} locale={locale} today={ready.period.endDate} appointment={appointment} onChange={commands ? () => setDialog({ kind: "APPOINTMENT" }) : undefined} />
          ) : (
            <section className="care-appointment care-appointment--none" aria-labelledby="care-appointment-none">
              <h2 className="care-appointment-title" id="care-appointment-none">
                {copy.noAppointmentTitle}
              </h2>
              {commands ? (
                <button type="button" className="btn btn-outline" onClick={() => setDialog({ kind: "APPOINTMENT" })}>
                  <PlusIcon size={20} />
                  {copy.addAppointment}
                </button>
              ) : null}
            </section>
          )}

          <p className="care-actions-tag">
            <PinIcon size={16} />
            {copy.actionsTag}
          </p>

          <fieldset className="care-facts">
            <legend className="eyebrow">{copy.includeHeading}</legend>
            {ready.factGroups.map((group) => {
              const count = group.sources.length;
              const { title, detail } = factGroupText(messages, locale, group.key, count, ready.period);
              return (
                <label key={group.key} className="care-fact">
                  <input type="checkbox" className="care-fact-input" checked={selectedGroups.has(group.key) && count > 0} disabled={count === 0} onChange={() => setSelectedGroups((set) => toggle(set, group.key))} />
                  <span className="care-fact-box" aria-hidden="true">
                    <CheckIcon size={22} />
                  </span>
                  <span className="care-fact-text">
                    <span className="care-fact-title">{title}</span>
                    <span className="care-fact-detail">{detail}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <section className="care-questions" aria-labelledby="care-questions-heading">
            <h2 className="eyebrow" id="care-questions-heading">
              {copy.questionsHeading}
            </h2>
            <p className="care-questions-intro">{copy.questionsIntro}</p>
            {questionGroups(messages).map((group) => (
              <details key={group.key} className="care-question-group">
                <summary>
                  <span className="care-question-group-icon" aria-hidden="true">
                    {group.icon}
                  </span>
                  <span className="care-question-group-text">
                    <span className="care-question-group-title">{group.title}</span>
                    <span className="care-question-group-count">{copy.noneSelected}</span>
                  </span>
                  <ChevronRightIcon size={22} className="icon care-question-group-chevron" />
                </summary>
                <p className="care-question-group-body">{copy.groupEmpty}</p>
              </details>
            ))}

            {ready.questions.length > 0 ? (
              <>
                <h3 className="care-own-heading">{copy.myQuestionsHeading}</h3>
                <ul className="care-own-list">
                  {ready.questions.map((question) => (
                    <li key={question.recordId} className="care-own">
                      <label className="care-own-include">
                        <input
                          type="checkbox"
                          aria-label={copy.includeQuestion(question.text)}
                          checked={selectedQuestions.has(question.recordId)}
                          onChange={() => setSelectedQuestions((set) => toggle(set, question.recordId))}
                        />
                        <span className="care-own-text" lang={langOf(question.language)}>
                          {question.text}
                        </span>
                      </label>
                      {rowFailure === question.recordId ? (
                        <p className="field-error" role="alert">
                          {copy.saveFailed}
                        </p>
                      ) : null}
                      {commands ? (
                        <div className="care-own-actions">
                          <button type="button" className="btn btn-outline" aria-label={copy.editQuestionNamed(question.text)} disabled={busy} onClick={() => setDialog({ kind: "EDIT_QUESTION", recordId: question.recordId })}>
                            <PencilIcon size={18} />
                            {copy.editQuestion}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline"
                            aria-label={copy.removeQuestionNamed(question.text)}
                            disabled={busy}
                            onClick={() =>
                              void commit(
                                () =>
                                  commands.reviseCareQuestion({
                                    recordId: question.recordId,
                                    expectedRevisionId: question.revisionId,
                                    expectedRevisionNumber: question.revisionNumber,
                                    questionText: { text: question.text, language: question.language },
                                    state: "DISMISSED",
                                  }),
                                { inDialog: false, failureKey: question.recordId },
                              )
                            }
                          >
                            <TrashIcon size={18} />
                            {copy.removeQuestion}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {commands ? (
              <button type="button" className="care-add-question" disabled={busy} onClick={() => setDialog({ kind: "ADD_QUESTION" })}>
                <PlusIcon size={22} />
                {copy.addOwnQuestion}
              </button>
            ) : null}
          </section>

          <p className="care-limitation">{copy.selectionLimitation}</p>
          {selectedCount === 0 ? <p className="care-empty-selection">{copy.emptySelection}</p> : null}
          {previewFailed ? (
            <p className="field-error" role="alert">
              {copy.saveFailed}
            </p>
          ) : null}
          <div className="care-summary-actions">
            <button type="button" className="btn btn-outline btn-wide" disabled={!onPreview || selectedCount === 0 || busy} onClick={() => void preview()}>
              <EyeIcon size={22} />
              {copy.previewSummary}
            </button>
            {/* Export is reached only through the preview and exact-hash approval (Packet 9C). */}
            <button type="button" className="btn btn-primary btn-wide" disabled={!onPreview || selectedCount === 0 || busy} onClick={() => void preview()}>
              <ShareIcon size={22} />
              {copy.exportOrPrint}
            </button>
            <p className="care-local-only">{copy.localOnly}</p>
          </div>
        </>
      ) : null}

      {dialog?.kind === "APPOINTMENT" && commands ? <AppointmentEditor messages={messages} appointment={appointment} busy={busy} failed={failed} onClose={closeDialog} onSave={saveAppointment} /> : null}

      {dialog?.kind === "ADD_QUESTION" && commands ? (
        <CareQuestionEditor
          messages={messages}
          initialText={null}
          busy={busy}
          failed={failed}
          onClose={closeDialog}
          onSave={(text) =>
            void commit(
              () =>
                commands.createCareQuestion({
                  questionText: { text, language: "und" },
                  ...(appointment ? { relatedAppointment: { recordType: "APPOINTMENT", recordId: appointment.recordId, revisionId: appointment.revisionId } } : {}),
                }),
              { inDialog: true },
            )
          }
        />
      ) : null}

      {dialog?.kind === "EDIT_QUESTION" && editingQuestion && commands ? (
        <CareQuestionEditor
          messages={messages}
          initialText={editingQuestion.text}
          busy={busy}
          failed={failed}
          onClose={closeDialog}
          onSave={(text) =>
            void commit(
              () =>
                commands.reviseCareQuestion({
                  recordId: editingQuestion.recordId,
                  expectedRevisionId: editingQuestion.revisionId,
                  expectedRevisionNumber: editingQuestion.revisionNumber,
                  // Unchanged words keep their language; new words are not guessed.
                  questionText: { text, language: text === editingQuestion.text ? editingQuestion.language : "und" },
                  state: "READY_TO_ASK",
                }),
              { inDialog: true },
            )
          }
        />
      ) : null}
    </div>
  );
}

function AppointmentCard({
  messages,
  locale,
  today,
  appointment,
  onChange,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  today: string;
  appointment: NonNullable<ReadyView["appointment"]>;
  onChange?: () => void;
}) {
  const copy = messages.carePreparation;
  const localDate = localDateOfPoint(appointment.scheduledAt);
  const days = localDate ? daysBetween(today, localDate) : null;
  // Plain calendar arithmetic only; "today" has no approved wording, so 0 days shows no count.
  const parts = [localDate ? formatWeekday(locale, localDate) : null, formatPointTime(locale, appointment.scheduledAt), days !== null && days > 0 ? copy.inDays(days) : null].filter((part): part is string => Boolean(part));
  const headingId = `care-appointment-${appointment.recordId}`;
  return (
    <section className="care-appointment" aria-labelledby={headingId}>
      {localDate ? (
        <div className="care-date-tile" aria-hidden="true">
          <span className="care-date-tile-month">{formatMonthShort(locale, localDate)}</span>
          <span className="care-date-tile-day">{Number(localDate.slice(8, 10))}</span>
        </div>
      ) : null}
      <div className="care-appointment-body">
        <div className="care-appointment-head">
          <h2 className="care-appointment-title" id={headingId}>
            {appointment.payload.appointmentLabel}
          </h2>
          {onChange ? (
            <button type="button" className="care-appointment-change" aria-label={copy.changeAppointment} title={copy.changeAppointment} onClick={onChange}>
              <PencilIcon size={18} />
              <span className="sr-only">{copy.changeAppointment}</span>
            </button>
          ) : null}
        </div>
        {localDate ? <p className="sr-only">{formatLocalDate(locale, localDate)}</p> : null}
        <p className="care-appointment-meta">{parts.join(" · ")}</p>
        <p className="care-appointment-provenance">
          {copy.appointmentEnteredByYou}
          <span aria-hidden="true"> · </span>
          {copy.appointmentUnverified}
        </p>
      </div>
    </section>
  );
}

function factGroupText(messages: AppMessages, locale: SupportedLocale, key: FactGroupKey, count: number, period: ReadyView["period"]): { title: string; detail: string } {
  const copy = messages.carePreparation;
  if (key === "GLUCOSE") return { title: copy.glucoseReadings, detail: copy.glucoseDetail(formatLocalDate(locale, period.startDate), formatLocalDate(locale, period.endDate), count) };
  const counted = (detail: string) => `${detail} · ${copy.recordsInPeriod(count)}`;
  if (key === "INSULIN") return { title: copy.insulinRecords, detail: counted(copy.insulinDetail) };
  if (key === "MEALS") return { title: copy.mealNotes, detail: counted(copy.mealDetail) };
  return { title: copy.walks, detail: counted(copy.walkDetail) };
}

function questionGroups(messages: AppMessages): Array<{ key: string; title: string; icon: ReactNode }> {
  const copy = messages.carePreparation;
  return [
    { key: "medicine-info", title: copy.medicineInfoQuestions, icon: <BookIcon size={24} /> },
    { key: "directions", title: copy.directionsQuestions, icon: <DocumentIcon size={24} /> },
    { key: "routines", title: copy.routineQuestions, icon: <PencilIcon size={24} /> },
    { key: "trends", title: copy.trendQuestions, icon: <ChartIcon size={24} /> },
    { key: "preventive", title: copy.preventiveQuestions, icon: <ShieldIcon size={24} /> },
  ];
}
