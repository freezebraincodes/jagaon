"use client";

import { useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { PreventiveCareItemPayload } from "@/domain/care-plan/preventive-care";
import type { PreventiveCareItemView, PreventiveHistoryEntry } from "@/application/care-organisation/care-organisation-contracts";
import { ModalDialog } from "../primitives/ModalDialog";
import { InputField, TextareaField } from "../primitives/Field";
import { localDateSchema, type LocalDate } from "@/domain/shared/time";
import { formatLocalDate, localDateOfPoint } from "./care-format";

type ItemDraft = { label: string; date: string; note: string; source: string };

/** Add or correct an item. A catalogue item keeps its reviewed identity; only patient fields change. */
export function PreventiveItemDialog({
  messages,
  item,
  itemLabel,
  busy,
  failed,
  onSave,
  onClose,
}: {
  messages: AppMessages;
  item: PreventiveCareItemView | null;
  itemLabel: string | null;
  busy: boolean;
  failed: boolean;
  onSave: (payload: PreventiveCareItemPayload) => void;
  onClose: () => void;
}) {
  const copy = messages.preventiveCare;
  const payload = item?.payload;
  const [draft, setDraft] = useState<ItemDraft>(() => ({
    label: payload?.identity.kind === "PATIENT_DEFINED" ? payload.identity.label : "",
    date: payload?.schedule.kind === "TARGET_DATE" ? payload.schedule.targetDate : "",
    note: payload?.patientNote?.text ?? "",
    source: payload?.patientReportedPlanText?.text ?? "",
  }));
  const [error, setError] = useState<string | undefined>();
  const editableName = !payload || payload.identity.kind === "PATIENT_DEFINED";

  function submit() {
    const label = draft.label.trim();
    if (editableName && label.length === 0) {
      setError(messages.shared.requiredField);
      return;
    }
    const targetDate = draft.date ? localDateSchema.safeParse(draft.date) : null;
    if (targetDate && !targetDate.success) {
      setError(messages.shared.requiredField);
      return;
    }
    setError(undefined);
    const note = draft.note.trim();
    const source = draft.source.trim();
    // Free text keeps the patient's own words; the language is not inferred.
    const text = (value: string) => ({ text: value, language: "und" as const });
    onSave({
      identity: payload && !editableName ? payload.identity : { kind: "PATIENT_DEFINED", label },
      trackingState: payload?.trackingState ?? "ACTIVE",
      schedule: targetDate?.success ? { kind: "TARGET_DATE", targetDate: targetDate.data } : { kind: "UNSCHEDULED" },
      ...(source ? { patientReportedPlanText: text(source) } : {}),
      ...(note ? { patientNote: text(note) } : {}),
    });
  }

  return (
    <ModalDialog
      title={item ? copy.edit : copy.addItem}
      description={item && itemLabel ? <p>{itemLabel}</p> : undefined}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : messages.shared.save}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
            {messages.shared.cancel}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {copy.saveFailed}
        </p>
      ) : null}
      {editableName ? (
        <InputField label={copy.itemNameLabel} value={draft.label} maxLength={120} onChange={(event) => setDraft({ ...draft, label: event.target.value })} error={error} />
      ) : null}
      <InputField label={`${copy.dateEntered} (${messages.shared.optional})`} type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
      <TextareaField label={`${copy.note} (${messages.shared.optional})`} value={draft.note} maxLength={1000} rows={2} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
      <InputField label={`${copy.source} (${messages.shared.optional})`} value={draft.source} maxLength={1000} onChange={(event) => setDraft({ ...draft, source: event.target.value })} />
    </ModalDialog>
  );
}

/** The patient reports the date the check happened; nothing is inferred. */
export function MarkRecordedDialog({
  messages,
  itemLabel,
  busy,
  failed,
  onSave,
  onClose,
}: {
  messages: AppMessages;
  itemLabel: string;
  busy: boolean;
  failed: boolean;
  onSave: (localDate: LocalDate) => void;
  onClose: () => void;
}) {
  const copy = messages.preventiveCare;
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | undefined>();
  function submit() {
    const parsed = localDateSchema.safeParse(date);
    if (!parsed.success) {
      setError(messages.shared.requiredField);
      return;
    }
    setError(undefined);
    onSave(parsed.data);
  }
  return (
    <ModalDialog
      title={copy.markRecorded}
      description={<p>{itemLabel}</p>}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : messages.shared.save}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
            {messages.shared.cancel}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {copy.saveFailed}
        </p>
      ) : null}
      <InputField label={copy.dateEntered} type="date" value={date} onChange={(event) => setDate(event.target.value)} error={error} required />
    </ModalDialog>
  );
}

function historyLabel(messages: AppMessages, entry: PreventiveHistoryEntry): string {
  const copy = messages.preventiveCare;
  if (entry.kind === "RECORD") return entry.action === "CORRECT" ? copy.historyRecordCorrected : copy.historyRecorded;
  return entry.action === "CREATE" ? copy.historyEntered : entry.action === "CORRECT" ? copy.historyCorrected : copy.historyChanged;
}

export function PreventiveHistoryDialog({ messages, locale, itemLabel, history, onClose }: { messages: AppMessages; locale: SupportedLocale; itemLabel: string; history: PreventiveHistoryEntry[]; onClose: () => void }) {
  const copy = messages.preventiveCare;
  return (
    <ModalDialog
      title={copy.history}
      description={<p>{itemLabel}</p>}
      onClose={onClose}
      actions={
        <button type="button" className="btn btn-outline btn-wide" onClick={onClose}>
          {messages.shared.close}
        </button>
      }
    >
      <ol className="care-history-list">
        {history.map((entry, index) => {
          const date =
            entry.dateEntered?.kind === "TARGET"
              ? formatLocalDate(locale, entry.dateEntered.localDate)
              : entry.dateEntered?.kind === "OCCURRENCE"
                ? (() => {
                    const local = localDateOfPoint(entry.dateEntered.occurrence);
                    return local ? formatLocalDate(locale, local) : copy.dateNotKnown;
                  })()
                : copy.statusNoDate;
          return (
            <li key={`${entry.revisionCreatedAt}-${index}`}>
              <p className="care-history-action">{historyLabel(messages, entry)}</p>
              <p>
                {copy.dateEntered}: {date}
              </p>
              {entry.note ? (
                <p>
                  {copy.note}: <span lang={entry.note.language === "und" ? undefined : entry.note.language}>{entry.note.text}</span>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </ModalDialog>
  );
}
