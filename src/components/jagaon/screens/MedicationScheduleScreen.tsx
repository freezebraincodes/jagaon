"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type {
  MedicationSchedulePort,
  MedicationScheduleView,
  PresentedBarrierQuestion,
  ScheduleCareQuestionView,
  ScheduleOccasionView,
  ScheduleReminderView,
} from "@/application/medication-schedule/medication-schedule-contracts";
import type { RecordId } from "@/domain/shared/identifiers";
import { formatScheduleDate, formatScheduleDay, formatScheduleTime } from "@/application/medication-schedule/schedule-format";
import { Notice } from "../primitives/ScreenHeader";
import { ModalDialog } from "../primitives/ModalDialog";
import {
  BellIcon,
  CalendarIcon,
  CheckIcon,
  CircleIcon,
  ClipboardIcon,
  MessageIcon,
  PenIcon,
  PencilIcon,
  PlusIcon,
  QuestionIcon,
  SunIcon,
  TrashIcon,
} from "../primitives/Icons";
import { formatList } from "../history/history-format";
import { RecordDialog, type RecordSubmission } from "../medication-schedule/RecordDialog";
import { BarrierDialog, type BarrierAnswer } from "../medication-schedule/BarrierDialog";
import { CareQuestionDialog } from "../medication-schedule/CareQuestionDialog";
import { ReminderConfirmDialog, ReminderTimeDialog, type ReminderChange } from "../medication-schedule/ReminderDialogs";
import { useCommandIdFor } from "../medication-schedule/command-id";
import { amountLabel, answerLabel, optionLabel, recordedStateLabel } from "../medication-schedule/schedule-labels";

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  schedule: MedicationSchedulePort | null;
  /** Medicines recorded in the current setup; a skipped setup has none. */
  medicationRecordIds: readonly string[];
};

type ReadyView = Extract<MedicationScheduleView, { status: "READY" }>;

type Dialog =
  | { kind: "RECORD"; occasion: ScheduleOccasionView; correcting: boolean }
  | { kind: "BARRIER_OFFER"; question: PresentedBarrierQuestion }
  | { kind: "BARRIER_CORRECT"; occasion: ScheduleOccasionView; responseRecordId: RecordId }
  | { kind: "BARRIER_REMOVE"; occasion: ScheduleOccasionView; responseRecordId: RecordId }
  | { kind: "QUESTION"; question: ScheduleCareQuestionView | null }
  | { kind: "QUESTION_REMOVE"; question: ScheduleCareQuestionView }
  | { kind: "REMINDER_TIME"; reminder: ScheduleReminderView }
  | { kind: "REMINDER_CONFIRM"; reminder: ScheduleReminderView; change: ReminderChange };

const BARRIER_OPTION_KEYS = ["FORGOT", "ROUTINE_CHANGED", "AWAY_FROM_HOME", "ACCESS_DIFFICULTY", "SIDE_EFFECT_CONCERN"] as const;

/**
 * Screen 11 — Medication schedule (Packet 8 design Section 8). Fixed recorded
 * times only, neutral journal states, an optional barrier question after an
 * explicit Skipped or Not sure record, descriptive counts, in-app reminders
 * and local care questions. Nothing here judges, explains or advises.
 */
export function MedicationScheduleScreen({ messages, locale, schedule, medicationRecordIds }: Props) {
  const copy = messages.schedule;
  const [view, setView] = useState<MedicationScheduleView | null>(null);
  /** Increments on every completed load, even when the view is unchanged. */
  const [loads, setLoads] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const commandIdFor = useCommandIdFor();
  const latest = useRef(0);
  const remindersHeadingRef = useRef<HTMLHeadingElement>(null);
  /** Control to focus once the reloaded view renders, when the opener was replaced. */
  const pendingFocus = useRef<string | null>(null);
  const scopeKey = medicationRecordIds.join("|");

  useEffect(() => {
    if (!schedule) return;
    const request = latest.current + 1;
    latest.current = request;
    void Promise.resolve()
      .then(() => schedule.load({ locale, medicationRecordIds: scopeKey === "" ? [] : scopeKey.split("|") }))
      .then((next) => {
        if (latest.current !== request) return;
        setView(next);
        setLoads((value) => value + 1);
      })
      .catch(() => {
        if (latest.current === request) setView({ status: "UNAVAILABLE" });
      });
  }, [schedule, locale, scopeKey, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const key = pendingFocus.current;
    if (!key || view === null) return;
    pendingFocus.current = null;
    // A dialog opened meanwhile owns focus; never pull it out.
    if (document.querySelector("[role=dialog]")) return;
    const target = document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`) ?? document.querySelector<HTMLElement>("main h1");
    target?.focus();
  }, [view, loads]);

  function open(next: Dialog) {
    setFailed(false);
    setBusy(false);
    setDialog(next);
  }

  function close() {
    if (busy) return;
    setDialog(null);
    setFailed(false);
  }

  async function run(action: () => Promise<{ kind: string }>, onSaved: () => void, focusKey?: string) {
    setBusy(true);
    setFailed(false);
    let saved = false;
    try {
      saved = (await action()).kind === "SAVED";
    } catch {
      saved = false;
    }
    setBusy(false);
    if (!saved) {
      setFailed(true);
      return;
    }
    if (focusKey) pendingFocus.current = focusKey;
    onSaved();
    reload();
  }

  // --- Commands ---------------------------------------------------------------------------

  async function saveRecord(occasion: ScheduleOccasionView, correcting: boolean, submission: RecordSubmission) {
    if (!schedule) return;
    const commandId = commandIdFor(JSON.stringify(["record", occasion.occasionId, occasion.record?.revisionId ?? null, submission]));
    setBusy(true);
    setFailed(false);
    let result: Awaited<ReturnType<MedicationSchedulePort["recordOccasion"]>>;
    try {
      result =
        correcting && occasion.record
          ? await schedule.correctOccasion({
              occasion: occasion.occasion,
              ...submission,
              locale,
              commandId,
              recordId: occasion.record.recordId,
              expectedRevisionId: occasion.record.revisionId,
              expectedRevisionNumber: occasion.record.revisionNumber,
            })
          : await schedule.recordOccasion({ occasion: occasion.occasion, ...submission, locale, commandId });
    } catch {
      result = { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
    setBusy(false);
    if (result.kind !== "SAVED") {
      setFailed(true);
      return;
    }
    setStatus(copy.saved);
    reload();
    // The optional question follows only an explicit Skipped or Not sure record.
    setDialog(result.offer ? { kind: "BARRIER_OFFER", question: result.offer } : null);
  }

  async function openOffer(occasion: ScheduleOccasionView) {
    if (!schedule || !occasion.record) return;
    const question = await schedule.openBarrierQuestion(occasion.record.recordId, locale).catch(() => null);
    if (question) open({ kind: "BARRIER_OFFER", question });
    else reload();
  }

  function answerOffer(question: PresentedBarrierQuestion, answer: BarrierAnswer) {
    if (!schedule) return;
    const commandId = commandIdFor(JSON.stringify(["answer", question.presentationKey, answer]));
    void run(
      () => schedule.answerBarrier({ question, answer, commandId }),
      () => {
        setStatus(copy.barrierSaved);
        setDialog(null);
      },
    );
  }

  function leaveOffer(question: PresentedBarrierQuestion, how: "SNOOZE" | "SKIP") {
    if (!schedule) return;
    void run(
      () => (how === "SNOOZE" ? schedule.snoozeBarrier(question, "TOMORROW") : schedule.dismissBarrier(question)),
      () => setDialog(null),
    );
  }

  function correctAnswer(occasionId: string, responseRecordId: RecordId, answer: BarrierAnswer) {
    if (!schedule) return;
    const commandId = commandIdFor(JSON.stringify(["correct-answer", responseRecordId, answer]));
    void run(
      () => schedule.correctBarrier({ responseRecordId, answer, commandId }),
      () => {
        setStatus(copy.barrierSaved);
        setDialog(null);
      },
      `occasion-${occasionId}`,
    );
  }

  function removeAnswer(occasionId: string, responseRecordId: RecordId) {
    if (!schedule) return;
    void run(
      () => schedule.removeBarrier(responseRecordId),
      () => {
        setStatus(copy.saved);
        setDialog(null);
      },
      `occasion-${occasionId}`,
    );
  }

  function saveQuestion(question: ScheduleCareQuestionView | null, text: string) {
    if (!schedule) return;
    const commandId = commandIdFor(JSON.stringify(["question", question?.revisionId ?? null, text]));
    void run(
      () =>
        question
          ? schedule.editCareQuestion({ question, text, language: locale, commandId })
          : schedule.saveCareQuestion({ text, language: locale, commandId }),
      () => {
        setStatus(copy.questionSaved);
        setDialog(null);
      },
    );
  }

  function removeQuestion(question: ScheduleCareQuestionView) {
    if (!schedule) return;
    const commandId = commandIdFor(JSON.stringify(["question-remove", question.revisionId]));
    void run(
      () => schedule.dismissCareQuestion({ question, commandId }),
      () => {
        setStatus(copy.saved);
        setDialog(null);
      },
      "add-question",
    );
  }

  function saveReminder(reminder: ScheduleReminderView, change: ReminderChange) {
    if (!schedule) return;
    const commandId = commandIdFor(JSON.stringify(["reminder", reminder.revisionId, change]));
    void run(
      () => schedule.saveReminder({ reminder, change, commandId }),
      () => {
        setStatus(copy.reminderSaved);
        setDialog(null);
      },
      `reminder-${reminder.recordId}`,
    );
  }

  // --- Rendering --------------------------------------------------------------------------

  function occasionLabel(occasion: ScheduleOccasionView) {
    return `${formatScheduleDate(locale, occasion.localDate)} · ${formatScheduleTime(locale, occasion.scheduledTime)}`;
  }

  function renderOccasion(occasion: ScheduleOccasionView) {
    const record = occasion.record;
    const titleId = `occasion-${occasion.occasionId.replaceAll(/[^a-zA-Z0-9-]/g, "-")}`;
    const barrier = occasion.barrier;
    return (
      <li key={occasion.occasionId}>
        <article className="today-card schedule-occasion" aria-labelledby={titleId}>
          <h3 className="schedule-occasion-title" id={titleId}>
            <span className="schedule-occasion-icon" aria-hidden="true">
              <PenIcon size={26} />
            </span>
            <span>
              {occasion.medicineName}
              <span className="sr-only"> · {occasionLabel(occasion)}</span>
            </span>
          </h3>
          <dl className="schedule-tiles">
            <div className="schedule-tile">
              <dt className="eyebrow">{copy.scheduled}</dt>
              <dd className="schedule-tile-value">
                <CalendarIcon size={22} />
                {formatScheduleTime(locale, occasion.scheduledTime)}
              </dd>
            </div>
            <div className={`schedule-tile ${record ? "schedule-tile--recorded" : ""}`.trim()}>
              <dt className="eyebrow">{copy.intakeRecord}</dt>
              <dd className="schedule-tile-value">
                {record ? <CheckIcon size={22} /> : <CircleIcon size={22} />}
                <span>{recordedStateLabel(copy, record?.state ?? null)}</span>
              </dd>
              {record?.amount ? <dd className="schedule-tile-detail">{amountLabel(copy, record.amount)}</dd> : null}
            </div>
          </dl>
          {/* Owner decision 2026-10-15: after a skipped dose, one neutral safety line (missing insulin can become urgent). */}
          {record?.state === "SKIPPED" ? (
            <p className="schedule-skip-safety" role="note">
              {copy.skippedSafety}
            </p>
          ) : null}
          <p className="source-attr">{copy.sourceFixture(formatScheduleDay(locale, occasion.scheduleSource.date))}</p>
          <div className="card-links">
            <button
              type="button"
              className="text-link text-link--large"
              data-focus-key={`occasion-${occasion.occasionId}`}
              onClick={() => open({ kind: "RECORD", occasion, correcting: record !== null })}
            >
              {record ? <PencilIcon size={22} /> : <PlusIcon size={22} />}
              {record ? copy.changeRecord : copy.addRecord}
              <span className="sr-only"> · {occasion.medicineName} · {occasionLabel(occasion)}</span>
            </button>
            {barrier.kind === "OFFER_AVAILABLE" ? (
              <button type="button" className="text-link" onClick={() => void openOffer(occasion)}>
                <QuestionIcon size={20} />
                {copy.barrierOfferTitle}
                <span className="sr-only"> · {occasion.medicineName} · {occasionLabel(occasion)}</span>
              </button>
            ) : null}
          </div>
          {barrier.kind === "ANSWERED" && occasion.record ? (
            <div className="schedule-answer">
              <p>{copy.answerRecordedAs(answerLabel(copy, barrier.answer))}</p>
              <div className="card-links">
                <button type="button" className="text-link" onClick={() => open({ kind: "BARRIER_CORRECT", occasion, responseRecordId: barrier.responseRecordId })}>
                  <PencilIcon size={20} />
                  {copy.barrierCorrect}
                  <span className="sr-only"> · {occasion.medicineName} · {occasionLabel(occasion)}</span>
                </button>
                <button type="button" className="text-link text-link--quiet" onClick={() => open({ kind: "BARRIER_REMOVE", occasion, responseRecordId: barrier.responseRecordId })}>
                  <TrashIcon size={20} />
                  {copy.barrierRemove}
                  <span className="sr-only"> · {occasion.medicineName} · {occasionLabel(occasion)}</span>
                </button>
              </div>
            </div>
          ) : null}
        </article>
      </li>
    );
  }

  function renderCounts(ready: ReadyView) {
    const range = `${formatScheduleDay(locale, ready.window.startDate)}`;
    const end = formatScheduleDay(locale, ready.window.endDate);
    return (
      <section className="today-card schedule-counts" aria-labelledby="schedule-counts-heading">
        <p className="schedule-badge">
          <ClipboardIcon size={18} />
          {copy.recordedDataBadge}
        </p>
        <h2 className="card-title" id="schedule-counts-heading">
          {copy.whatRecorded(range, end)}
        </h2>
        <p className="schedule-muted">{copy.countIntro}</p>
        {ready.counts.length === 0 ? (
          <p className="schedule-count-empty">{copy.noBarrierCounts}</p>
        ) : (
          <ul className="schedule-count-list">
            {ready.counts.map((count) => {
              const label = optionLabel(copy, count.optionKey);
              const evidence = count.evidence.map((entry) => `${formatScheduleDay(locale, entry.localDate)} ${formatScheduleTime(locale, entry.scheduledTime)}`);
              return (
                <li key={count.optionKey}>
                  <p className="schedule-count-text">{count.occasionCount === 1 ? copy.countOne(label) : copy.countMany(label, count.occasionCount)}</p>
                  <p className="schedule-muted">{copy.countEvidence(formatList(locale, evidence))}</p>
                </li>
              );
            })}
          </ul>
        )}
        <div className="schedule-count-notes">
          {ready.excludedCorrected > 0 ? <p>{copy.countExcluded(ready.excludedCorrected)}</p> : null}
          {ready.unrecordedCount > 0 ? <p>{ready.unrecordedCount === 1 ? copy.unrecordedCountOne : copy.unrecordedCountMany(ready.unrecordedCount)}</p> : null}
          <p>{copy.countLimitation}</p>
          <p>{copy.countMeaning}</p>
        </div>
        <p className="schedule-badge schedule-badge--actions">{copy.actionsBadge}</p>
        <div className="schedule-actions">
          <button
            type="button"
            className="text-link text-link--large schedule-action--plain"
            onClick={() => {
              const heading = remindersHeadingRef.current;
              if (!heading) return;
              heading.scrollIntoView({ block: "start" });
              heading.focus();
            }}
          >
            <BellIcon size={22} />
            {copy.changeReminderSettings}
          </button>
          <button type="button" className="text-link text-link--large" data-focus-key="add-question" onClick={() => open({ kind: "QUESTION", question: null })}>
            <MessageIcon size={22} />
            {copy.addProfessionalQuestion}
          </button>
        </div>
        {ready.careQuestions.length > 0 ? (
          <div className="schedule-questions">
            <h3 className="eyebrow">{copy.questionTitle}</h3>
            <ul>
              {ready.careQuestions.map((question) => (
                <li key={question.recordId} className="schedule-question">
                  <p lang={question.language === "und" ? undefined : question.language}>{question.text}</p>
                  <div className="card-links">
                    <button type="button" className="text-link" onClick={() => open({ kind: "QUESTION", question })}>
                      <PencilIcon size={20} />
                      {copy.questionEdit}
                    </button>
                    <button type="button" className="text-link text-link--quiet" onClick={() => open({ kind: "QUESTION_REMOVE", question })}>
                      <TrashIcon size={20} />
                      {copy.questionRemove}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  }

  function reminderSchedule(reminder: ScheduleReminderView) {
    const times = reminder.times.map((time) => formatScheduleTime(locale, time)).join(" · ");
    if (reminder.daysOfWeek.length === 7) return copy.reminderDaily(times);
    return copy.reminderOnDays(formatList(locale, reminder.daysOfWeek.map((day) => copy.dayNames[day as keyof typeof copy.dayNames])), times);
  }

  function renderReminder(reminder: ScheduleReminderView) {
    const titleId = `reminder-${reminder.recordId}`;
    const on = reminder.state === "ACTIVE";
    const icon = reminder.subject === "MEDICATION" ? <PenIcon size={26} /> : reminder.subject === "MEASUREMENT" ? <SunIcon size={26} /> : <CalendarIcon size={26} />;
    return (
      <li key={reminder.recordId}>
        <article className="today-card schedule-reminder" aria-labelledby={titleId}>
          <div className="schedule-reminder-row">
            <span className="schedule-reminder-icon" aria-hidden="true">
              {icon}
            </span>
            <div className="schedule-reminder-text">
              <h3 className="schedule-reminder-title" id={titleId}>
                {reminder.label}
              </h3>
              <p className="schedule-muted">{reminderSchedule(reminder)}</p>
            </div>
            {reminder.state === "REVIEW_REQUIRED" ? null : (
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={copy.reminderToggleLabel(reminder.label)}
                className="schedule-switch"
                data-focus-key={`reminder-${reminder.recordId}`}
                onClick={() => open({ kind: "REMINDER_CONFIRM", reminder, change: { kind: on ? "PAUSE" : "RESUME" } })}
              >
                <span className="schedule-switch-label">{on ? copy.reminderOn : copy.reminderOff}</span>
                <span className="schedule-switch-track" aria-hidden="true" />
              </button>
            )}
          </div>
          {reminder.state === "REVIEW_REQUIRED" ? (
            <div className="schedule-review">
              <p className="schedule-badge schedule-badge--review">{copy.reminderReview}</p>
              <p>{copy.reminderReviewBody}</p>
              <button
                type="button"
                className="btn btn-outline btn-wide"
                data-focus-key={`reminder-${reminder.recordId}`}
                onClick={() => open({ kind: "REMINDER_CONFIRM", reminder, change: { kind: "CONFIRM_REVIEW" } })}
              >
                {copy.reminderReviewAction}
                <span className="sr-only"> · {reminder.label}</span>
              </button>
            </div>
          ) : reminder.subject !== "MEDICATION" ? (
            <button type="button" className="text-link" onClick={() => open({ kind: "REMINDER_TIME", reminder })}>
              <PencilIcon size={20} />
              {copy.reminderTimeLabel}
              <span className="sr-only"> · {reminder.label}</span>
            </button>
          ) : null}
        </article>
      </li>
    );
  }

  function renderReady(ready: ReadyView) {
    const sections = (["YESTERDAY", "TODAY"] as const).map((section) => ({
      section,
      occasions: ready.occasions.filter((occasion) => occasion.section === section),
    }));
    const hasOccasions = ready.occasions.length > 0;
    return (
      <>
        {hasOccasions ? (
          sections.map(({ section, occasions }) =>
            occasions.length === 0 ? null : (
              <section key={section} className="schedule-section" aria-labelledby={`schedule-${section}`}>
                <h2 className="eyebrow schedule-section-heading" id={`schedule-${section}`}>
                  {section === "YESTERDAY"
                    ? copy.sectionYesterday(formatScheduleDay(locale, ready.yesterday))
                    : copy.sectionToday(formatScheduleDay(locale, ready.today))}
                </h2>
                <ul className="schedule-list">{occasions.map(renderOccasion)}</ul>
              </section>
            ),
          )
        ) : (
          <section className="today-card history-state" aria-labelledby="schedule-empty-heading">
            <h2 id="schedule-empty-heading" className="card-title">
              {copy.emptyTitle}
            </h2>
            <p>{copy.emptyBody}</p>
          </section>
        )}
        {ready.withoutFixedTime.length > 0 ? (
          <ul className="schedule-no-fixed">
            {ready.withoutFixedTime.map((entry) => (
              <li key={entry.medicineName}>{copy.noFixedTimeFor(entry.medicineName)}</li>
            ))}
          </ul>
        ) : null}
        {hasOccasions ? (
          <Notice>
            <p>{copy.missingMeaning}</p>
          </Notice>
        ) : null}
        {renderCounts(ready)}
        <section className="schedule-section" aria-labelledby="schedule-reminders-heading">
          <h2 className="eyebrow schedule-section-heading" id="schedule-reminders-heading" ref={remindersHeadingRef} tabIndex={-1}>
            {copy.remindersHeading}
          </h2>
          <ul className="schedule-list">{ready.reminders.map(renderReminder)}</ul>
          <p className="schedule-footnote">
            {copy.reminderLimitation} {copy.inAppOnly}
          </p>
        </section>
      </>
    );
  }

  function renderDialog() {
    if (!dialog) return null;
    switch (dialog.kind) {
      case "RECORD":
        return (
          <RecordDialog
            messages={messages}
            locale={locale}
            occasion={dialog.occasion}
            correcting={dialog.correcting}
            busy={busy}
            failed={failed}
            onSave={(submission) => void saveRecord(dialog.occasion, dialog.correcting, submission)}
            onClose={close}
          />
        );
      case "BARRIER_OFFER":
        return (
          <BarrierDialog
            messages={messages}
            locale={locale}
            leadIn={dialog.question.leadIn}
            question={dialog.question.question}
            options={dialog.question.options}
            mode="OFFER"
            busy={busy}
            failed={failed}
            onSave={(answer) => answerOffer(dialog.question, answer)}
            onSnooze={() => leaveOffer(dialog.question, "SNOOZE")}
            onSkip={() => leaveOffer(dialog.question, "SKIP")}
            onClose={close}
          />
        );
      case "BARRIER_CORRECT": {
        const occasion = dialog.occasion;
        const status = occasion.record?.state === "NOT_SURE" ? copy.optionNotSure : copy.optionSkipped;
        return (
          <BarrierDialog
            messages={messages}
            locale={locale}
            leadIn={copy.barrierWhy(status, occasion.medicineName, formatScheduleDate(locale, occasion.localDate))}
            question={copy.barrierQuestion}
            options={BARRIER_OPTION_KEYS.map((optionKey) => ({ optionKey, label: optionLabel(copy, optionKey) }))}
            mode="CORRECT"
            busy={busy}
            failed={failed}
            onSave={(answer) => correctAnswer(occasion.occasionId, dialog.responseRecordId, answer)}
            onClose={close}
          />
        );
      }
      case "BARRIER_REMOVE":
        return (
          <ConfirmRemove
            title={copy.barrierRemove}
            body={`${dialog.occasion.medicineName} · ${occasionLabel(dialog.occasion)}`}
            confirmLabel={copy.barrierRemove}
            cancelLabel={copy.cancelRecord}
            failedText={copy.barrierSaveFailed}
            busy={busy}
            failed={failed}
            savingLabel={messages.shared.saving}
            onConfirm={() => removeAnswer(dialog.occasion.occasionId, dialog.responseRecordId)}
            onClose={close}
          />
        );
      case "QUESTION":
        return (
          <CareQuestionDialog
            messages={messages}
            initialText={dialog.question?.text ?? ""}
            editing={dialog.question !== null}
            busy={busy}
            failed={failed}
            onSave={(text) => saveQuestion(dialog.question, text)}
            onClose={close}
          />
        );
      case "QUESTION_REMOVE":
        return (
          <ConfirmRemove
            title={copy.questionRemove}
            body={dialog.question.text}
            confirmLabel={copy.questionRemove}
            cancelLabel={copy.cancelRecord}
            failedText={copy.saveFailedBody}
            busy={busy}
            failed={failed}
            savingLabel={messages.shared.saving}
            onConfirm={() => removeQuestion(dialog.question)}
            onClose={close}
          />
        );
      case "REMINDER_TIME":
        return (
          <ReminderTimeDialog
            messages={messages}
            reminder={dialog.reminder}
            onContinue={(time) => open({ kind: "REMINDER_CONFIRM", reminder: dialog.reminder, change: { kind: "CHANGE_TIME", time } })}
            onClose={close}
          />
        );
      case "REMINDER_CONFIRM":
        return (
          <ReminderConfirmDialog
            messages={messages}
            locale={locale}
            reminder={dialog.reminder}
            change={dialog.change}
            busy={busy}
            failed={failed}
            onConfirm={() => saveReminder(dialog.reminder, dialog.change)}
            onClose={close}
          />
        );
    }
  }

  return (
    <div className="schedule-screen">
      <h1 className="screen-title">{copy.title}</h1>
      <Notice>
        <p>{copy.notAdvice}</p>
      </Notice>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {!schedule || view === null ? (
        <p role="status" className="history-loading">
          {copy.loading}
        </p>
      ) : view.status === "UNAVAILABLE" ? (
        <section className="today-card history-state" aria-labelledby="schedule-unavailable-heading">
          <h2 id="schedule-unavailable-heading" className="card-title">
            {copy.unavailableTitle}
          </h2>
          <p>{copy.unavailableBody}</p>
          <button
            type="button"
            className="btn btn-outline btn-wide"
            onClick={() => {
              setView(null);
              reload();
            }}
          >
            {copy.retry}
          </button>
        </section>
      ) : (
        renderReady(view)
      )}
      {renderDialog()}
    </div>
  );
}

function ConfirmRemove({
  title,
  body,
  confirmLabel,
  cancelLabel,
  failedText,
  savingLabel,
  busy,
  failed,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  failedText: string;
  savingLabel: string;
  busy: boolean;
  failed: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      title={title}
      description={<p>{body}</p>}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-dark btn-wide" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn-danger-outline btn-wide" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? savingLabel : confirmLabel}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {failedText}
        </p>
      ) : null}
    </ModalDialog>
  );
}
