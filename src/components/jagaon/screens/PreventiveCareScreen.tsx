"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { LocalDate } from "@/domain/shared/time";
import { findPreventiveCareCatalogueEntry, type PreventiveCareItemPayload } from "@/domain/care-plan/preventive-care";
import type { CareOrganisationCommandPort, CareOrganisationCommitResult } from "@/application/care-organisation/care-organisation-contracts";
import type { CareOrganisationQueryPort, PreventiveCareItemView, PreventiveCareStatus, PreventiveCareView } from "@/application/care-organisation/care-organisation-contracts";
import { ScreenHeader, Notice } from "../primitives/ScreenHeader";
import {
  CalendarIcon,
  CheckIcon,
  CircleIcon,
  DropIcon,
  EyeIcon,
  HistoryIcon,
  PencilIcon,
  PlusIcon,
  ResetIcon,
  ShieldIcon,
  StethoscopeIcon,
  WalkIcon,
  CalendarCheckIcon,
} from "../primitives/Icons";
import { MarkRecordedDialog, PreventiveHistoryDialog, PreventiveItemDialog } from "../care-organisation/PreventiveCareDialogs";
import { formatLocalDate, localDateOfPoint } from "../care-organisation/care-format";
import { useCareLoad } from "../care-organisation/use-care-load";

type ScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  query: CareOrganisationQueryPort | null;
  commands: CareOrganisationCommandPort | null;
};

type Dialog = { kind: "ADD" } | { kind: "EDIT"; recordId: string } | { kind: "RECORD"; recordId: string } | { kind: "HISTORY"; recordId: string } | null;

const HOME_TIME_ZONE = "Asia/Singapore";

/** The reviewed catalogue label in the current locale; a patient-defined label stays verbatim. */
export function preventiveItemLabel(payload: PreventiveCareItemPayload, locale: SupportedLocale): string {
  const identity = payload.identity;
  if (identity.kind === "PATIENT_DEFINED") return identity.label;
  return findPreventiveCareCatalogueEntry(identity.catalogueEntryKey, identity.catalogueVersion)?.labels[locale] ?? identity.label;
}

function itemIcon(payload: PreventiveCareItemPayload): ReactNode {
  const key = payload.identity.kind === "REVIEWED_CATALOGUE_MATCH" ? payload.identity.catalogueEntryKey : null;
  if (key === "EYE_SCREENING") return <EyeIcon size={26} />;
  if (key === "BLOOD_TEST") return <DropIcon size={26} />;
  if (key === "FOOT_CHECK") return <WalkIcon size={26} />;
  if (key === "FLU_VACCINE") return <ShieldIcon size={26} />;
  return <CalendarCheckIcon size={26} />;
}

function StatusChip({ status, messages }: { status: PreventiveCareStatus; messages: AppMessages }) {
  const copy = messages.preventiveCare;
  // Text and icon carry the state; colour only repeats it.
  if (status === "RECORDED")
    return (
      <span className="care-status care-status--recorded">
        <CheckIcon size={18} />
        {copy.statusRecorded}
      </span>
    );
  if (status === "SCHEDULED")
    return (
      <span className="care-status care-status--scheduled">
        <CalendarIcon size={18} />
        {copy.statusScheduled}
      </span>
    );
  return (
    <span className="care-status care-status--none">
      <CircleIcon size={18} />
      {copy.statusNoDate}
    </span>
  );
}

function enteredDate(item: PreventiveCareItemView, messages: AppMessages, locale: SupportedLocale): string {
  const copy = messages.preventiveCare;
  if (!item.dateEntered) return copy.statusNoDate;
  if (item.dateEntered.kind === "TARGET") return formatLocalDate(locale, item.dateEntered.localDate);
  const local = localDateOfPoint(item.dateEntered.occurrence);
  return local ? formatLocalDate(locale, local) : copy.dateNotKnown;
}

const langOf = (language: string) => (language === "und" ? undefined : language);

/**
 * Screen 09 — My health checks. Every date and note is one the patient
 * entered; the app never decides what is due, needed or eligible. General
 * information sits in its own region and is never personalised.
 */
export function PreventiveCareScreen({ messages, locale, query, commands }: ScreenProps) {
  const copy = messages.preventiveCare;
  const loader = useMemo(() => (query ? () => query.loadPreventiveCare() : null), [query]);
  const { value: view, reload } = useCareLoad<PreventiveCareView>(loader, { status: "UNAVAILABLE" });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [rowFailure, setRowFailure] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function commit(write: () => Promise<CareOrganisationCommitResult>, { inDialog }: { inDialog: boolean }, failureKey?: string) {
    setBusy(true);
    setFailed(false);
    setRowFailure(null);
    setAnnouncement("");
    const result = await write();
    if (!mounted.current) return;
    setBusy(false);
    if (result.kind !== "COMMITTED") {
      // Nothing is claimed saved; the patient's values stay where they were.
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

  const items = view?.status === "READY" ? view.items : [];
  const dialogItem = dialog && dialog.kind !== "ADD" ? (items.find((item) => item.recordId === dialog.recordId) ?? null) : null;

  return (
    <div className="preventive-care">
      <ScreenHeader title={copy.title} />
      <Notice>
        <p>{copy.maintainedByYou}</p>
      </Notice>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {view === null ? <p className="care-loading">{copy.loading}</p> : null}

      {view?.status === "UNAVAILABLE" ? (
        <div className="banner banner-error" role="alert">
          <p className="banner-title">{copy.unavailableTitle}</p>
        </div>
      ) : null}

      {view?.status === "READY" && items.length === 0 ? (
        <div className="onboarding-empty care-empty">
          <p className="care-empty-title">{copy.emptyTitle}</p>
          <p>{copy.emptyBody}</p>
        </div>
      ) : null}

      {view?.status === "READY" && items.length > 0 ? (
        <ul className="care-item-list">
          {items.map((item) => {
            const label = preventiveItemLabel(item.payload, locale);
            const note = item.payload.patientNote;
            const source = item.payload.patientReportedPlanText;
            const record = item.currentRecord;
            const headingId = `care-item-${item.recordId}`;
            return (
              <li key={item.recordId}>
                <article className="card care-item" aria-labelledby={headingId}>
                  <div className="care-item-head">
                    <span className="care-item-icon" aria-hidden="true">
                      {itemIcon(item.payload)}
                    </span>
                    <h2 className="care-item-title" id={headingId}>
                      {label}
                    </h2>
                    <StatusChip status={item.status} messages={messages} />
                  </div>
                  <dl className="care-item-facts">
                    <div>
                      <dt>{copy.dateEntered}</dt>
                      <dd>{enteredDate(item, messages, locale)}</dd>
                    </div>
                    {note ? (
                      <div>
                        <dt>{copy.note}</dt>
                        <dd lang={langOf(note.language)}>{note.text}</dd>
                      </div>
                    ) : null}
                    {source ? (
                      <div>
                        <dt>{copy.source}</dt>
                        <dd lang={langOf(source.language)}>{source.text}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {rowFailure === item.recordId ? (
                    <p className="field-error" role="alert">
                      {copy.saveFailed}
                    </p>
                  ) : null}
                  {commands ? (
                    <div className="care-item-actions">
                      {item.status === "RECORDED" && record ? (
                        <button
                          type="button"
                          className="btn btn-outline"
                          aria-label={`${copy.undoRecorded}: ${label}`}
                          disabled={busy}
                          onClick={() => {
                            void commit(
                              () => commands.undoPreventiveOutcome({ recordId: record.recordId, expectedRevisionId: record.revisionId, expectedRevisionNumber: record.revisionNumber }),
                              { inDialog: false },
                              item.recordId,
                            );
                          }}
                        >
                          <ResetIcon size={20} />
                          {copy.undoRecorded}
                        </button>
                      ) : (
                        <button type="button" className="btn btn-outline" aria-label={`${copy.markRecorded}: ${label}`} disabled={busy} onClick={() => setDialog({ kind: "RECORD", recordId: item.recordId })}>
                          <CheckIcon size={20} />
                          {copy.markRecorded}
                        </button>
                      )}
                      <button type="button" className="btn btn-outline" aria-label={`${copy.edit}: ${label}`} disabled={busy} onClick={() => setDialog({ kind: "EDIT", recordId: item.recordId })}>
                        <PencilIcon size={20} />
                        {copy.edit}
                      </button>
                      <button type="button" className="btn btn-outline" aria-label={`${copy.history}: ${label}`} onClick={() => setDialog({ kind: "HISTORY", recordId: item.recordId })}>
                        <HistoryIcon size={20} />
                        {copy.history}
                      </button>
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}

      {view?.status === "READY" && commands ? (
        <button type="button" className="care-add-question" disabled={busy} onClick={() => setDialog({ kind: "ADD" })}>
          <PlusIcon size={22} />
          {copy.addItem}
        </button>
      ) : null}

      <Notice className="notice--compact">
        <p>{copy.recordLimitation}</p>
      </Notice>

      <GeneralInformation messages={messages} />

      {dialog?.kind === "ADD" && commands ? (
        <PreventiveItemDialog
          messages={messages}
          item={null}
          itemLabel={null}
          busy={busy}
          failed={failed}
          onClose={closeDialog}
          onSave={(payload) => void commit(() => commands.createPreventiveItem({ payload }), { inDialog: true })}
        />
      ) : null}

      {dialog?.kind === "EDIT" && dialogItem && commands ? (
        <PreventiveItemDialog
          messages={messages}
          item={dialogItem}
          itemLabel={preventiveItemLabel(dialogItem.payload, locale)}
          busy={busy}
          failed={failed}
          onClose={closeDialog}
          onSave={(payload) =>
            void commit(
              () =>
                commands.revisePreventiveItem({
                  recordId: dialogItem.recordId,
                  expectedRevisionId: dialogItem.revisionId,
                  expectedRevisionNumber: dialogItem.revisionNumber,
                  payload,
                  intent: "CORRECT",
                }),
              { inDialog: true },
            )
          }
        />
      ) : null}

      {dialog?.kind === "RECORD" && dialogItem && commands ? (
        <MarkRecordedDialog
          messages={messages}
          itemLabel={preventiveItemLabel(dialogItem.payload, locale)}
          busy={busy}
          failed={failed}
          onClose={closeDialog}
          onSave={(localDate: LocalDate) =>
            void commit(
              () =>
                commands.recordPreventiveOutcome({
                  payload: {
                    careReference: { kind: "PLANNED_ITEM", item: { recordType: "PREVENTIVE_CARE_ITEM", recordId: dialogItem.recordId, revisionId: dialogItem.revisionId } },
                    completionReport: { kind: "PATIENT_REPORTED_COMPLETED" },
                  },
                  occurrence: { kind: "DATE_ONLY", localDate, timeZoneId: HOME_TIME_ZONE },
                }),
              { inDialog: true },
            )
          }
        />
      ) : null}

      {dialog?.kind === "HISTORY" && dialogItem ? (
        <PreventiveHistoryDialog messages={messages} locale={locale} itemLabel={preventiveItemLabel(dialogItem.payload, locale)} history={dialogItem.history} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

/**
 * General preventive-health topics. No reviewed content asset is bundled yet,
 * so the topics are titles only and never expand into personal advice. The
 * approved "reviewed" tag and intro stay hidden until such an asset exists.
 */
function GeneralInformation({ messages }: { messages: AppMessages }) {
  const copy = messages.preventiveCare;
  const topics = [
    { key: "eye", icon: <EyeIcon size={24} />, title: copy.topicEyeTitle, kind: copy.topicEyeKind },
    { key: "vaccination", icon: <ShieldIcon size={24} />, title: copy.topicVaccinationTitle, kind: copy.topicVaccinationKind },
    { key: "lifestyle", icon: <WalkIcon size={24} />, title: copy.topicLifestyleTitle, kind: copy.topicLifestyleKind },
    { key: "follow-up", icon: <StethoscopeIcon size={24} />, title: copy.topicFollowUpTitle, kind: copy.topicFollowUpKind },
  ];
  return (
    <section className="care-general" aria-labelledby="care-general-heading">
      <h2 className="eyebrow care-general-heading" id="care-general-heading">
        {copy.generalHeading}
      </h2>
      <ul className="care-topic-list">
        {topics.map((topic) => (
          <li key={topic.key} className="care-topic">
            <span className="care-topic-icon" aria-hidden="true">
              {topic.icon}
            </span>
            <div>
              <h3 className="care-topic-title">{topic.title}</h3>
              <p className="care-topic-kind">{topic.kind}</p>
              <p className="care-topic-note">{copy.generalNotAssessment}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
