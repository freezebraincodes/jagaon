"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteThemeCount, PersonalNoteQueryPort, PersonalNoteView } from "@/application/notes/personal-note-query";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { PencilIcon, TrashIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
import { useCareLoad } from "../care-organisation/use-care-load";
import type { RecordDeletionPort } from "../data/data-ports";
import { RecordDeletionDialog } from "../data/RecordDeletionDialog";
import { formatSingaporeDateTime } from "../journal/singapore-time";

/** The read port this screen needs, plus the existing permanent record deletion (optional: without it no delete action is offered). */
export type MyNotesPorts = Readonly<{
  query: PersonalNoteQueryPort;
  deletion?: RecordDeletionPort;
}>;

type MyNotesScreenProps = {
  messages: AppMessages;
  locale?: SupportedLocale;
  notes?: MyNotesPorts;
  /** Injectable clock (tests); defaults to the device clock. */
  now?: () => string;
};

type NotesView = { status: "READY"; notes: readonly PersonalNoteView[]; counts: readonly NoteThemeCount[] } | { status: "UNAVAILABLE" };

const MAX_THEME_LINES = 3;
const NO_NOTES: NotesView = Object.freeze({ status: "READY", notes: [], counts: [] });
const deviceNow = () => new Date().toISOString();
const langOf = (language: string) => (language === "und" ? undefined : language);

/**
 * Owner decision 2026-10-14 (My notes): the notes the person chose to keep, newest first, with this week's recurring themes (at most
 * three lines; descriptive only, never a cause or a diagnosis) and, when a note came from a short chat, the conversation behind it.
 * One note is deleted through the existing permanent-deletion dialog. Without a notes port (nothing to read) the empty line is shown.
 */
export function MyNotesScreen({ messages, locale = "en-SG", notes, now = deviceNow }: MyNotesScreenProps) {
  const msg = messages.myNotes;
  const query = notes?.query ?? null;
  const deletion = notes?.deletion;
  // The clock is read on each load; the loader changes only with the port.
  const clock = useRef(now);
  useEffect(() => {
    clock.current = now;
  }, [now]);
  const loader = useMemo(
    () =>
      query
        ? async (): Promise<NotesView> => {
            const [list, counts] = await Promise.all([query.listPersonalNotes(), query.themeCounts({ now: clock.current(), days: 7 })]);
            return { status: "READY", notes: list, counts };
          }
        : null,
    [query],
  );
  const { value: loaded, reload } = useCareLoad<NotesView>(loader, { status: "UNAVAILABLE" });
  // No notes port: nothing is stored to read, so the empty line shows at once.
  const view: NotesView | null = query ? loaded : NO_NOTES;
  const [deleting, setDeleting] = useState<PersonalNoteView | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const deleteOpener = useRef<HTMLButtonElement | null>(null);

  const when = (note: PersonalNoteView) => formatSingaporeDateTime(locale, note.recordedAt);

  return (
    <div className="screen-page my-notes-screen">
      <ScreenHeader title={msg.title} />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {view === null ? <p className="care-loading">{msg.loading}</p> : null}

      {view?.status === "UNAVAILABLE" ? (
        <div className="banner banner-error" role="alert">
          <p className="banner-title">{msg.unavailable}</p>
        </div>
      ) : null}

      {view?.status === "READY" && view.counts.length > 0 ? (
        <section className="my-notes-themes" aria-labelledby="my-notes-themes-heading">
          <h2 id="my-notes-themes-heading" className="eyebrow">
            {msg.themesHeading}
          </h2>
          <ul className="my-notes-theme-lines">
            {view.counts.slice(0, MAX_THEME_LINES).map((entry) => (
              <li key={entry.theme}>{msg.themeCount(msg.themeLabels[entry.theme], entry.count)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {view?.status === "READY" && view.notes.length === 0 ? <Notice icon={<PencilIcon size={20} />}>{msg.empty}</Notice> : null}

      {view?.status === "READY" && view.notes.length > 0 ? (
        <ul className="care-item-list my-notes-list">
          {view.notes.map((note) => {
            const headingId = `my-note-${note.recordId}`;
            const { payload } = note;
            return (
              <li key={note.recordId}>
                <article className="card care-item my-note" aria-labelledby={headingId}>
                  <h2 className="my-note-when" id={headingId}>
                    <time dateTime={note.recordedAt}>{when(note)}</time>
                  </h2>
                  <p className="my-note-text" lang={langOf(payload.language)}>
                    {payload.text}
                  </p>
                  {payload.themes.length > 0 ? (
                    <ul className="my-note-themes" aria-label={msg.themesLabel}>
                      {payload.themes.map((theme) => (
                        <li key={theme} className="care-status">
                          {msg.themeLabels[theme]}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {payload.turns.length > 0 ? (
                    <details className="my-note-conversation">
                      <summary>{msg.conversation}</summary>
                      <ul>
                        {payload.turns.map((turn, index) => (
                          <li key={index} lang={langOf(payload.language)}>
                            <span className="my-note-speaker">{turn.role === "PATIENT" ? msg.speakerYou : msg.speakerJagaOn}: </span>
                            {turn.text}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {deletion ? (
                    <div className="card-links">
                      <button
                        type="button"
                        className="text-link text-link--danger"
                        aria-describedby={headingId}
                        onClick={(event) => {
                          deleteOpener.current = event.currentTarget;
                          setAnnouncement("");
                          setDeleting(note);
                        }}
                      >
                        <TrashIcon size={18} />
                        {msg.deleteNote}
                      </button>
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}

      {deleting && deletion ? (
        <RecordDeletionDialog
          messages={messages}
          locale={locale}
          port={deletion}
          target={{ recordType: "PERSONAL_NOTE", recordId: deleting.recordId }}
          recordLabel={msg.noteRecordLabel}
          recordWhen={when(deleting)}
          now={now}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setAnnouncement(msg.deleted);
            reload();
          }}
          returnFocusRef={deleteOpener}
        />
      ) : null}
    </div>
  );
}
